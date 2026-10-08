use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{Value, json};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_PublicDesktop, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM,
    FOS_NODEREFERENCELINKS, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS,
    FileOpenDialog, FileSaveDialog, IFileDialog, IFileOpenDialog, IFileSaveDialog,
    SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW, SHGetKnownFolderPath, SIGDN_FILESYSPATH,
    ShellExecuteExW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{Interface, PCWSTR, w};

use crate::protocol::{read_json_record, write_json_record};
use crate::validation::{
    MAX_CONFIGURATION_BYTES, MEDIA_CHUNK_BYTES, MediaKind, TargetKind, classify_target,
    media_kind_for_path, normalize_canonical_windows_path, read_configuration, validate_arguments,
    validate_configuration, validate_media_size,
};

const ALLOWED_PROTOCOLS: [u32; 2] = [4, 5];
const MAX_DESKTOP_ENTRIES: usize = 4096;

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|error| format!("Could not initialize the Windows Shell: {error}"))?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub fn run() -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let init = read_json_record(&mut reader, None)
        .map_err(|error| format!("Could not read host initialization: {error}"))?
        .ok_or_else(|| "Host closed before initialization.".to_owned())?;
    if init.get("type").and_then(Value::as_str) != Some("init") {
        return Err("The first host record was not init.".to_owned());
    }
    let version = init
        .get("v")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "Host initialization has no protocol version.".to_owned())?;
    if !ALLOWED_PROTOCOLS.contains(&version) {
        let mut stdout = io::stdout().lock();
        let _ = write_json_record(
            &mut stdout,
            5,
            &json!({
                "type":"error",
                "v":version,
                "message":"Unsupported companion protocol version."
            }),
        );
        return Err(format!("Unsupported host protocol version {version}."));
    }

    // The runtime requires `ready` promptly. COM startup and all Shell work
    // happen only after this acknowledgement.
    {
        let mut stdout = io::stdout().lock();
        write_json_record(&mut stdout, version, &json!({"type":"ready", "v":version}))
            .map_err(|error| format!("Could not acknowledge initialization: {error}"))?;
    }

    let apartment = ComApartment::initialize().ok();
    let mut running = true;
    while running {
        let frame = match read_json_record(&mut reader, Some(version)) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) => {
                send_protocol_error(version, &format!("Invalid host record: {error}"))?;
                break;
            }
        };

        if frame.get("v").and_then(Value::as_u64) != Some(u64::from(version)) {
            send_protocol_error(
                version,
                "Host record protocol version changed during the session.",
            )?;
            break;
        }
        match frame.get("type").and_then(Value::as_str) {
            Some("shutdown") => running = false,
            Some("message") => {
                let Some(payload) = frame.get("payload") else {
                    continue;
                };
                if payload.get("kind").and_then(Value::as_str) != Some("panels.command") {
                    continue;
                }
                let result = handle_command(payload, apartment.is_some());
                send_message(version, result)?;
            }
            Some("settings") | Some("init") | Some("activate") | Some("deactivate") => {}
            Some(_) | None => {}
        }
    }

    drop(apartment);
    Ok(())
}

fn handle_command(payload: &Value, com_available: bool) -> Value {
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= 128)
        .unwrap_or("");
    let result = (|| {
        let action = payload
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| "Command action must be a string.".to_owned())?;
        let input = payload
            .get("input")
            .and_then(Value::as_object)
            .ok_or_else(|| "Command input must be an object.".to_owned())?;
        match action {
            "pickTarget" => {
                require_com(com_available)?;
                let kind = string_field(input, "kind")?;
                if !matches!(kind, "file" | "folder") {
                    return Err("Target picker kind must be file or folder.".to_owned());
                }
                pick_target(kind, None)
            }
            "pickMedia" => {
                require_com(com_available)?;
                let kind = string_field(input, "kind")?;
                let media_kind = match kind {
                    "image" => MediaKind::Image,
                    "video" => MediaKind::Video,
                    _ => return Err("Media picker kind must be image or video.".to_owned()),
                };
                pick_media(media_kind)
            }
            "desktopEntries" => desktop_entries(),
            "importConfiguration" => {
                require_com(com_available)?;
                import_configuration()
            }
            "exportConfiguration" => {
                require_com(com_available)?;
                export_configuration(string_field(input, "configuration")?)
            }
            "open" => {
                require_com(com_available)?;
                let target = string_field(input, "target")?;
                let arguments = input.get("arguments").and_then(Value::as_str);
                open_target(target, arguments)?;
                Ok(Value::Null)
            }
            "mediaInfo" => media_info(string_field(input, "path")?),
            "mediaChunk" => {
                let path = string_field(input, "path")?;
                let offset = input.get("offset").and_then(Value::as_u64).ok_or_else(|| {
                    "Media chunk offset must be a non-negative integer.".to_owned()
                })?;
                media_chunk(path, offset)
            }
            _ => Err("Unknown Desktop Panels command.".to_owned()),
        }
    })();

    match result {
        Ok(value) => json!({
            "kind":"panels.result",
            "requestId":request_id,
            "ok":true,
            "result":value
        }),
        Err(error) => json!({
            "kind":"panels.result",
            "requestId":request_id,
            "ok":false,
            "error":error
        }),
    }
}

fn require_com(available: bool) -> Result<(), String> {
    if available {
        Ok(())
    } else {
        Err("Windows Shell COM could not be initialized for this command.".to_owned())
    }
}

fn string_field<'a>(
    input: &'a serde_json::Map<String, Value>,
    name: &str,
) -> Result<&'a str, String> {
    input
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Command field `{name}` must be a string."))
}

fn configuration_dialog(save: bool) -> Result<Option<PathBuf>, String> {
    let dialog: IFileDialog = if save {
        let dialog: IFileSaveDialog =
            unsafe { CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("Could not create the save dialog: {error}"))?;
        dialog.cast()
    } else {
        let dialog: IFileOpenDialog =
            unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("Could not create the import dialog: {error}"))?;
        dialog.cast()
    }
    .map_err(|error| format!("Could not initialize the configuration dialog: {error}"))?;
    let mut options = unsafe { dialog.GetOptions() }
        .map_err(|error| format!("Could not read dialog options: {error}"))?;
    options |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
    options |= if save {
        FOS_OVERWRITEPROMPT
    } else {
        FOS_FILEMUSTEXIST
    };
    let filters = [COMDLG_FILTERSPEC {
        pszName: w!("JSON configuration"),
        pszSpec: w!("*.json"),
    }];
    (|| unsafe {
        dialog.SetOptions(options)?;
        dialog.SetFileTypes(&filters)?;
        dialog.SetDefaultExtension(w!("json"))?;
        dialog.SetTitle(if save {
            w!("Export Desktop Panels configuration")
        } else {
            w!("Import Desktop Panels configuration")
        })?;
        if save {
            dialog.SetFileName(w!("desktop-panels.json"))?;
        }
        Ok::<_, windows::core::Error>(())
    })()
    .map_err(|error| format!("Could not configure the dialog: {error}"))?;
    if let Err(error) = unsafe { dialog.Show(None) } {
        if error.code().0 as u32 == 0x8007_04c7 {
            return Ok(None);
        }
        return Err(format!("Configuration dialog failed: {error}"));
    }
    let item = unsafe { dialog.GetResult() }
        .map_err(|error| format!("Could not read the selected configuration: {error}"))?;
    let raw = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }
        .map_err(|error| format!("Could not read the selected path: {error}"))?;
    let path = unsafe { raw.to_string() }
        .map_err(|error| format!("Could not decode the selected path: {error}"));
    unsafe { CoTaskMemFree(Some(raw.0.cast())) };
    let path = PathBuf::from(path?);
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Choose a JSON configuration file.".to_owned());
    }
    Ok(Some(path))
}

fn import_configuration() -> Result<Value, String> {
    let Some(path) = configuration_dialog(false)? else {
        return Ok(Value::Null);
    };
    let file =
        File::open(path).map_err(|error| format!("Could not open the configuration: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect the configuration: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIGURATION_BYTES as u64 {
        return Err("Select a regular JSON file of at most 192 KiB.".to_owned());
    }
    read_configuration(file).map(Value::String)
}

fn export_configuration(value: &str) -> Result<Value, String> {
    validate_configuration(value)?;
    let Some(path) = configuration_dialog(true)? else {
        return Ok(Value::Null);
    };
    fs::write(path, value.as_bytes())
        .map_err(|error| format!("Could not save the configuration: {error}"))?;
    Ok(Value::Null)
}

fn pick_target(kind: &str, media_filter: Option<MediaKind>) -> Result<Value, String> {
    let dialog: IFileOpenDialog =
        unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("Could not create the Windows picker: {error}"))?;
    let mut options = unsafe { dialog.GetOptions() }
        .map_err(|error| format!("Could not read Windows picker options: {error}"))?;
    options |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
    if kind == "folder" {
        options |= FOS_PICKFOLDERS;
        options &= !FOS_FILEMUSTEXIST;
    } else {
        options |= FOS_FILEMUSTEXIST;
        if media_filter.is_none() {
            // Preserve the .lnk itself so ShellExecute can apply the shortcut's
            // target, working directory, and arguments.
            options |= FOS_NODEREFERENCELINKS;
        }
    }
    unsafe { dialog.SetOptions(options) }
        .map_err(|error| format!("Could not configure the Windows picker: {error}"))?;
    let title = match (kind, media_filter) {
        ("folder", _) => w!("Choose a folder"),
        ("file", Some(MediaKind::Image)) => w!("Choose an image"),
        ("file", Some(MediaKind::Video)) => w!("Choose a video"),
        _ => w!("Choose a file"),
    };
    unsafe { dialog.SetTitle(title) }
        .map_err(|error| format!("Could not set the Windows picker title: {error}"))?;
    if let Some(media_kind) = media_filter {
        let filters = media_filters(media_kind);
        unsafe { dialog.SetFileTypes(&filters) }
            .map_err(|error| format!("Could not configure media file types: {error}"))?;
    }

    if let Err(error) = unsafe { dialog.Show(None) } {
        if error.code().0 as u32 == 0x8007_04c7 {
            return Ok(Value::Null);
        }
        return Err(format!("Windows picker failed: {error}"));
    }
    let item = unsafe { dialog.GetResult() }
        .map_err(|error| format!("Could not read the selected item: {error}"))?;
    let raw_path = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }
        .map_err(|error| format!("Could not read the selected path: {error}"))?;
    let path = unsafe { raw_path.to_string() }
        .map_err(|error| format!("Could not decode the selected path: {error}"));
    unsafe { CoTaskMemFree(Some(raw_path.0.cast())) };
    let path = path?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Selected path is no longer available: {error}"))?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect the selected path: {error}"))?;
    if kind == "folder" && !metadata.is_dir() {
        return Err("The selected item is not a folder.".to_owned());
    }
    if kind == "file" && !metadata.is_file() {
        return Err("The selected item is not a file.".to_owned());
    }
    if let Some(media_kind) = media_filter {
        if media_kind_for_path(&path) != Some(media_kind) {
            return Err("The selected file does not match the requested media type.".to_owned());
        }
        validate_media_size(&path, metadata.len())?;
    }
    let label = display_label(&path);
    let path = normalize_canonical_windows_path(&path.to_string_lossy())?;
    if media_filter.is_some() {
        Ok(json!({"path":path,"label":label}))
    } else {
        Ok(json!({"target":path,"label":label}))
    }
}

fn media_filters(kind: MediaKind) -> Vec<COMDLG_FILTERSPEC> {
    match kind {
        MediaKind::Image => vec![
            COMDLG_FILTERSPEC {
                pszName: w!("Image files"),
                pszSpec: w!("*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif"),
            },
            COMDLG_FILTERSPEC {
                pszName: w!("All files"),
                pszSpec: w!("*.*"),
            },
        ],
        MediaKind::Video => vec![
            COMDLG_FILTERSPEC {
                pszName: w!("Video files"),
                pszSpec: w!("*.mp4;*.webm;*.mov;*.m4v;*.ogv"),
            },
            COMDLG_FILTERSPEC {
                pszName: w!("All files"),
                pszSpec: w!("*.*"),
            },
        ],
    }
}

fn pick_media(kind: MediaKind) -> Result<Value, String> {
    pick_target("file", Some(kind))
}

fn desktop_entries() -> Result<Value, String> {
    let mut roots = Vec::new();
    if let Ok(path) = known_folder_path(&FOLDERID_Desktop) {
        roots.push(path);
    } else if let Some(path) = fallback_desktop_path("USERPROFILE") {
        roots.push(path);
    }
    if let Ok(path) = known_folder_path(&FOLDERID_PublicDesktop) {
        roots.push(path);
    } else if let Some(path) = fallback_desktop_path("PUBLIC") {
        roots.push(path);
    }

    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for root in roots {
        let Ok(items) = fs::read_dir(root) else {
            continue;
        };
        for item in items.flatten() {
            let path = item.path();
            if item
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("desktop.ini")
            {
                continue;
            }
            let Ok(path) = path.canonicalize() else {
                continue;
            };
            let Ok(target) = normalize_canonical_windows_path(&path.to_string_lossy()) else {
                continue;
            };
            if !seen.insert(target.to_ascii_lowercase()) {
                continue;
            }
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            let kind = if metadata.is_dir() {
                "folder"
            } else if metadata.is_file() {
                "file"
            } else {
                continue;
            };
            entries.push(json!({
                "target":target,
                "label":display_label(&path),
                "kind":kind
            }));
            if entries.len() > MAX_DESKTOP_ENTRIES {
                return Err(format!(
                    "Desktop has more than {MAX_DESKTOP_ENTRIES} entries."
                ));
            }
        }
    }
    entries.sort_by(|left, right| {
        left.get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .cmp(
                &right
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_ascii_lowercase(),
            )
    });
    Ok(Value::Array(entries))
}

fn known_folder_path(folder_id: &windows::core::GUID) -> Result<PathBuf, String> {
    let path = unsafe { SHGetKnownFolderPath(folder_id, Default::default(), None) }
        .map_err(|error| format!("Could not find a Windows Desktop folder: {error}"))?;
    let value = unsafe { path.to_string() }
        .map_err(|error| format!("Could not decode a Windows Desktop folder: {error}"));
    unsafe { CoTaskMemFree(Some(path.0.cast())) };
    value.map(PathBuf::from)
}

fn fallback_desktop_path(variable: &str) -> Option<PathBuf> {
    std::env::var_os(variable).map(|root| PathBuf::from(root).join("Desktop"))
}

fn display_label(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
    {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    } else {
        name.into_owned()
    }
}

fn open_target(target: &str, arguments: Option<&str>) -> Result<(), String> {
    let kind = classify_target(target)?;
    let arguments = validate_arguments(arguments)?;
    let (target_wide, arguments_wide) = match kind {
        TargetKind::Url => {
            if !arguments.is_empty() {
                return Err(
                    "Arguments can only be supplied for an executable or shortcut path.".to_owned(),
                );
            }
            (wide_null(target), wide_null(""))
        }
        TargetKind::WindowsPath => {
            let path = PathBuf::from(target)
                .canonicalize()
                .map_err(|error| format!("Target path is unavailable: {error}"))?;
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Could not inspect target path: {error}"))?;
            if !metadata.is_file() && !metadata.is_dir() {
                return Err("Target must be a file or folder.".to_owned());
            }
            if !arguments.is_empty()
                && !path.extension().is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("lnk")
                })
            {
                return Err(
                    "Arguments can only be supplied for an executable or shortcut path.".to_owned(),
                );
            }
            let target = normalize_canonical_windows_path(&path.to_string_lossy())?;
            (wide_null(&target), wide_null(arguments))
        }
    };

    let mut execute = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_FLAG_NO_UI,
        hwnd: HWND::default(),
        lpVerb: PCWSTR::null(),
        lpFile: PCWSTR(target_wide.as_ptr()),
        lpParameters: PCWSTR(arguments_wide.as_ptr()),
        lpDirectory: PCWSTR::null(),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut execute) }
        .map_err(|error| format!("Windows could not open the selected target: {error}"))
}

fn media_file(path: &str) -> Result<(PathBuf, File, u64, &'static str), String> {
    if path.is_empty() || path.contains('\0') || path.trim() != path {
        return Err("Media path must be a non-empty selected file path.".to_owned());
    }
    if classify_target(path)? != TargetKind::WindowsPath {
        return Err("Media path must be an absolute selected Windows file path.".to_owned());
    }
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Selected media is unavailable: {error}"))?;
    let file =
        File::open(&path).map_err(|error| format!("Could not read selected media: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect selected media: {error}"))?;
    if !metadata.is_file() {
        return Err("Selected media path is not a file.".to_owned());
    }
    let size = metadata.len();
    let mime = validate_media_size(&path, size)?;
    Ok((path, file, size, mime))
}

fn media_info(path: &str) -> Result<Value, String> {
    let (_, _, size, mime) = media_file(path)?;
    Ok(json!({"size":size,"mime":mime}))
}

fn media_chunk(path: &str, offset: u64) -> Result<Value, String> {
    let (_, mut file, size, _) = media_file(path)?;
    if offset > size {
        return Err("Media chunk offset is beyond the end of the file.".to_owned());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Could not seek selected media: {error}"))?;
    let remaining = size - offset;
    let chunk_length = usize::try_from(remaining.min(MEDIA_CHUNK_BYTES as u64))
        .map_err(|_| "Media chunk length is invalid.".to_owned())?;
    let mut bytes = vec![0; chunk_length];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Selected media changed while reading: {error}"))?;
    let eof = offset + chunk_length as u64 >= size;
    Ok(json!({
        "data":base64::engine::general_purpose::STANDARD.encode(bytes),
        "eof":eof
    }))
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn send_message(version: u32, payload: Value) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    write_json_record(
        &mut stdout,
        version,
        &json!({"type":"message", "v":version, "target":"broadcast", "payload":payload}),
    )
    .map_err(|error| format!("Could not send command result: {error}"))
}

fn send_protocol_error(version: u32, message: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    write_json_record(
        &mut stdout,
        version,
        &json!({"type":"error", "v":version, "message":message}),
    )
    .map_err(|error| format!("Could not report companion protocol error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_shortcut_labels_hide_lnk_suffix() {
        assert_eq!(
            display_label(Path::new(r"C:\Users\me\Desktop\Browser.lnk")),
            "Browser"
        );
        assert_eq!(
            display_label(Path::new(r"C:\Users\me\Desktop\Notes.txt")),
            "Notes.txt"
        );
    }

    #[test]
    fn command_envelopes_have_stable_result_shapes() {
        let payload = json!({
            "kind":"panels.command",
            "requestId":"r1",
            "action":"pickTarget",
            "input":{"kind":"other"}
        });
        let result = handle_command(&payload, false);
        assert_eq!(result["kind"], "panels.result");
        assert_eq!(result["requestId"], "r1");
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().is_some());
    }

    #[test]
    fn apartment_failure_only_disables_shell_commands() {
        let payload = json!({
            "kind":"panels.command",
            "requestId":"r1",
            "action":"mediaInfo",
            "input":{"path":r"C:\__desktop_panels_missing_test__\missing.png"}
        });
        let result = handle_command(&payload, false);
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap().contains("unavailable"));
    }
}
