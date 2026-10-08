use std::io::Read;
use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetKind {
    Url,
    WindowsPath,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaKind {
    Image,
    Video,
}

pub const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;
pub const MAX_VIDEO_BYTES: u64 = 64 * 1024 * 1024;
pub const MEDIA_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_ARGUMENTS_UTF16: usize = 8192;
pub const MAX_CONFIGURATION_BYTES: usize = 192 * 1024;

pub fn validate_configuration(value: &str) -> Result<(), String> {
    if value.len() > MAX_CONFIGURATION_BYTES {
        return Err("Configuration exceeds the 192 KiB size limit.".to_owned());
    }
    let parsed: serde_json::Value = serde_json::from_str(value)
        .map_err(|error| format!("Configuration is not valid JSON: {error}"))?;
    if !parsed.is_object() {
        return Err("Configuration must be a JSON object.".to_owned());
    }
    Ok(())
}

pub fn read_configuration(reader: impl Read) -> Result<String, String> {
    // Bound the actual read even if the selected file grows after inspection.
    let mut bytes = Vec::new();
    reader
        .take((MAX_CONFIGURATION_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the configuration: {error}"))?;
    if bytes.len() > MAX_CONFIGURATION_BYTES {
        return Err("Configuration exceeds the 192 KiB size limit.".to_owned());
    }
    let mut value = String::from_utf8(bytes)
        .map_err(|_| "Configuration must use UTF-8 encoding.".to_owned())?;
    // Match the previous browser file reader, including Windows UTF-8 BOM files.
    if value.starts_with('\u{feff}') {
        value.drain(..'\u{feff}'.len_utf8());
    }
    validate_configuration(&value)?;
    Ok(value)
}

pub fn classify_target(value: &str) -> Result<TargetKind, String> {
    if value.is_empty() || value.trim() != value || value.contains('\0') {
        return Err("Target must be a non-empty absolute path or supported URL.".to_owned());
    }
    if value.encode_utf16().count() > 32_767 || value.chars().any(char::is_control) {
        return Err("Target is too long or contains control characters.".to_owned());
    }

    if is_drive_path(value) || is_unc_path(value) {
        return Ok(TargetKind::WindowsPath);
    }

    let Some((scheme, suffix)) = value.split_once(':') else {
        return Err(
            "Target must be an absolute Windows path or http, https, or mailto URL.".to_owned(),
        );
    };
    match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" => {
            let expected_prefix = format!("{}://", scheme.to_ascii_lowercase());
            if !value
                .get(..expected_prefix.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&expected_prefix))
            {
                return Err("Web links must use an absolute http:// or https:// URL.".to_owned());
            }
            let rest = &value[expected_prefix.len()..];
            let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
            if authority.is_empty()
                || authority.contains('@')
                || authority.chars().any(char::is_whitespace)
            {
                return Err("Web URL must have a host and cannot include credentials.".to_owned());
            }
            Ok(TargetKind::Url)
        }
        "mailto" => {
            if suffix.is_empty() || suffix.chars().any(char::is_whitespace) || suffix.contains('\\')
            {
                return Err("mailto URL must contain a recipient and no spaces.".to_owned());
            }
            Ok(TargetKind::Url)
        }
        "javascript" | "data" | "vbscript" => {
            Err("Script and data URLs cannot be opened.".to_owned())
        }
        _ => Err(
            "Only http, https, mailto URLs and absolute Windows paths are supported.".to_owned(),
        ),
    }
}

pub fn validate_arguments(value: Option<&str>) -> Result<&str, String> {
    let value = value.unwrap_or_default();
    if value.contains('\0') || value.encode_utf16().count() > MAX_ARGUMENTS_UTF16 {
        return Err("Arguments are too long or contain a null character.".to_owned());
    }
    Ok(value)
}

pub fn media_kind_for_path(path: &Path) -> Option<MediaKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif" => Some(MediaKind::Image),
        "mp4" | "webm" | "mov" | "m4v" | "ogv" => Some(MediaKind::Video),
        _ => None,
    }
}

pub fn mime_for_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        _ => return None,
    })
}

pub fn max_media_bytes(path: &Path) -> Option<u64> {
    Some(match media_kind_for_path(path)? {
        MediaKind::Image => MAX_IMAGE_BYTES,
        MediaKind::Video => MAX_VIDEO_BYTES,
    })
}

pub fn validate_media_size(path: &Path, size: u64) -> Result<&'static str, String> {
    let mime = mime_for_path(path).ok_or_else(|| "Unsupported image or video type.".to_owned())?;
    let limit = max_media_bytes(path).expect("MIME extensions are also media extensions");
    if size > limit {
        return Err(format!(
            "Selected media exceeds the {limit} byte size limit."
        ));
    }
    Ok(mime)
}

pub fn is_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

pub fn normalize_canonical_windows_path(value: &str) -> Result<String, String> {
    const EXTENDED_PREFIX: &str = "\\\\?\\";
    const EXTENDED_UNC_PREFIX: &str = "\\\\?\\UNC\\";

    let normalized = if value
        .get(..EXTENDED_UNC_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(EXTENDED_UNC_PREFIX))
    {
        format!("\\\\{}", &value[EXTENDED_UNC_PREFIX.len()..])
    } else if value
        .get(..EXTENDED_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(EXTENDED_PREFIX))
    {
        let path = &value[EXTENDED_PREFIX.len()..];
        if !is_drive_path(path) {
            return Err("Windows device namespace paths are not supported.".to_owned());
        }
        path.to_owned()
    } else {
        value.to_owned()
    };

    if is_drive_path(&normalized) || is_unc_path(&normalized) {
        Ok(normalized)
    } else {
        Err("Canonical path is not a regular Windows drive or UNC path.".to_owned())
    }
}

fn is_unc_path(value: &str) -> bool {
    if !value.starts_with("\\\\") || value.starts_with("\\\\?\\") || value.starts_with("\\\\.\\") {
        return false;
    }
    let mut components = value[2..]
        .split(['\\', '/'])
        .filter(|part| !part.is_empty());
    components.next().is_some() && components.next().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_is_bounded_utf8_json_without_transforming_private_paths() {
        let value = r#"{"version":1,"target":"C:\\Users\\Élodie\\Notes.lnk"}"#;
        assert_eq!(read_configuration(value.as_bytes()).unwrap(), value);
        assert_eq!(
            read_configuration(format!("\u{feff}{value}").as_bytes()).unwrap(),
            value
        );
        assert!(read_configuration(&[0xff][..]).is_err());
        assert!(validate_configuration("[]").is_err());
        assert!(validate_configuration("{broken").is_err());
        assert!(validate_configuration(&" ".repeat(MAX_CONFIGURATION_BYTES + 1)).is_err());
    }

    #[test]
    fn configuration_read_stops_at_the_limit_even_if_the_source_keeps_growing() {
        let mut source = std::io::repeat(b' ');
        assert!(read_configuration(&mut source).is_err());
    }

    #[test]
    fn accepts_only_absolute_windows_paths_or_allowed_schemes() {
        assert_eq!(
            classify_target(r"C:\Program Files\App\app.exe").unwrap(),
            TargetKind::WindowsPath
        );
        assert_eq!(
            classify_target(r"\\server\share\folder").unwrap(),
            TargetKind::WindowsPath
        );
        assert_eq!(
            classify_target("https://example.org/path").unwrap(),
            TargetKind::Url
        );
        assert_eq!(
            classify_target("mailto:person@example.org").unwrap(),
            TargetKind::Url
        );
        assert!(classify_target("relative\\app.lnk").is_err());
        assert!(classify_target("javascript:alert(1)").is_err());
        assert!(classify_target("data:text/html,<script>").is_err());
        assert!(classify_target("vbscript:msgbox(1)").is_err());
        assert!(classify_target("https://").is_err());
        assert!(classify_target("https://user:password@example.org/").is_err());
        assert!(classify_target(r"\\?\C:\device-path").is_err());
    }

    #[test]
    fn canonical_path_normalization_round_trips_drive_and_unicode_unc_paths() {
        assert_eq!(
            normalize_canonical_windows_path(r"\\?\C:\Users\Élodie\Desktop\Notes.lnk").unwrap(),
            r"C:\Users\Élodie\Desktop\Notes.lnk"
        );
        assert_eq!(
            normalize_canonical_windows_path(r"\\?\UNC\serveur\partage\Bureau\Café.lnk").unwrap(),
            r"\\serveur\partage\Bureau\Café.lnk"
        );
        let drive =
            normalize_canonical_windows_path(r"\\?\C:\Users\Élodie\Desktop\Notes.lnk").unwrap();
        let unc =
            normalize_canonical_windows_path(r"\\?\UNC\serveur\partage\Bureau\Café.lnk").unwrap();
        assert_eq!(classify_target(&drive), Ok(TargetKind::WindowsPath));
        assert_eq!(classify_target(&unc), Ok(TargetKind::WindowsPath));
        assert!(
            normalize_canonical_windows_path(r"\\?\GLOBALROOT\Device\HarddiskVolume1").is_err()
        );
        assert!(normalize_canonical_windows_path(r"\\.\PhysicalDrive0").is_err());
    }

    #[test]
    fn argument_payload_is_bounded_and_null_free() {
        assert_eq!(validate_arguments(None).unwrap(), "");
        assert_eq!(
            validate_arguments(Some("--open file.txt")).unwrap(),
            "--open file.txt"
        );
        assert!(validate_arguments(Some("bad\0argument")).is_err());
        assert!(validate_arguments(Some(&"x".repeat(MAX_ARGUMENTS_UTF16 + 1))).is_err());
    }

    #[test]
    fn media_mime_and_per_type_limits_are_extension_based() {
        assert_eq!(mime_for_path(Path::new("photo.PNG")), Some("image/png"));
        assert_eq!(mime_for_path(Path::new("movie.MP4")), Some("video/mp4"));
        assert_eq!(
            max_media_bytes(Path::new("photo.webp")),
            Some(MAX_IMAGE_BYTES)
        );
        assert_eq!(
            max_media_bytes(Path::new("movie.webm")),
            Some(MAX_VIDEO_BYTES)
        );
        assert!(validate_media_size(Path::new("photo.png"), MAX_IMAGE_BYTES).is_ok());
        assert!(validate_media_size(Path::new("photo.png"), MAX_IMAGE_BYTES + 1).is_err());
        assert!(validate_media_size(Path::new("movie.mp4"), MAX_VIDEO_BYTES + 1).is_err());
        assert!(mime_for_path(Path::new("archive.zip")).is_none());
    }
}
