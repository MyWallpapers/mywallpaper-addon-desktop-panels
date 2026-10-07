# Desktop Panels

A MyWallpaper add-on for composing a personal desktop launcher from web buttons. This checkout is a local preview, not a published release.

## What is implemented

- One visual add-on containing a collection of buttons, not independent sub-add-ons.
- A visual editor opened by **Manage buttons** in the existing MyWallpaper settings, with **Import configuration** and **Export configuration** actions there as well.
- Rectangles with adjustable corners, ellipses, triangles and hexagons; per-button size, position, color, label and icon.
- Pointer drag and resize; numeric position/size fields; arrow keys move a focused button by one canvas unit, Shift + arrow by ten.
- Images and muted, looping videos, including playback only on hover/focus.
- Windows file/application/shortcut/folder pickers; HTTP(S) and mailto links; optional executable/shortcut arguments.
- Read-only import from the user's and public Windows Desktop folders. Original shortcuts are never deleted, hidden or edited.
- Duplicate/delete buttons and explicit JSON import/export.

## Run the local previews

Install dependencies with `pnpm install`, then run `pnpm preview`. Open `http://localhost:5194/?demo=1` for the visual demonstration. Example buttons in this mode do not open real files or applications.

For real local targets, build the companion on Windows with Rust 1.94.1:

```powershell
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = '-C link-arg=/Brepro -C link-arg=/DEBUG:NONE'
cargo install --path native/companion --locked --target x86_64-pc-windows-msvc --root native/out/windows-x86_64 --force
node scripts/preview-bridge.mjs
```

Then open `http://localhost:5194/?demo=0`. The preview bridge is a development-only, loopback service on port 5195, restricted to the exact preview origin and an ephemeral request token. It is not shipped in the release outputs.

`pnpm build` produces the exported Canvas `mount(context)` entry. The canonical CLI uses `mywallpaper.config.json` to build the web bundle and Windows companion separately.

## Runtime and data

The web layer owns the editor and layout. A small Rust `process-v2` companion owns Windows Shell file selection, directory enumeration, media reads and `ShellExecuteExW`. It communicates through the existing host IPC, with no HTTP server in the published executable. No shell command string or PowerShell/cmd intermediary is assembled.

The companion runs with ordinary user privileges after MyWallpaper's exact native add-on consent. This is not an OS sandbox or a narrow file-picker permission. Windows may independently ask for permission if the user opens an application that requires it.

The versioned layout JSON uses ordinary **layer settings**: shapes, positions, colors, names and shared URLs follow the wallpaper, so applying a wallpaper restores its creator's layout. Private application/file targets, arguments and local media paths use **device settings**, partitioned by layer and button ID. They never enter the published wallpaper. The existing host retains account, add-on source and schema isolation. Copies remain independent.

The editor combines both sets of values transparently. **Export configuration** saves a complete JSON backup, including local references; **Import configuration** loads it into the editor for confirmation. Exports do not embed media files, and local references must exist on the receiving PC. Media bytes are read only when needed; moving or deleting an original media file requires selecting it again.

The layout uses a 1600 × 900 reference canvas and scales proportionally to the available layer. It does not change the browser zoom or the Windows taskbar. New installs start empty; demonstration data exists only in the preview and thumbnail modes.

## Temporary scope

This version is a temporary, ordinary add-on using the existing Canvas, native companion and device-settings contracts. It includes no Core changes, Explorer modifications, cross-copy synchronization service or additional storage API.

Each layer keeps the layout supplied by its wallpaper unless the user edits it or imports another configuration. There is no automatic global replacement of layouts when changing wallpaper; JSON export/import provides explicit manual reuse.

Concurrent edits across different copies use the host's existing whole-value save behavior; this temporary version adds no conflict-resolution mechanism. The existing Windows desktop pointer routing also remains unchanged. The browser preview exercises the editor and actions but does not establish Windows desktop hit-testing behavior.

Open the preview through `http://localhost:5194/`, not by opening `index.html` as a `file://` URL: Vite serves the TypeScript modules and preview assets.

## Resource bounds and checks

Images: at most 12 MiB per source. Videos: at most 64 MiB. Native media transfers use 256 KiB chunks. The local payload/Blob cache is bounded to 96 MiB and 48 entries; visible decoded browser media uses additional memory. Offscreen videos and hidden documents are paused, and only one hover-triggered video is activated at a time. The editor caps a collection at 1024 buttons and each configuration value at 192 KiB UTF-8, leaving room for both escaped settings values and host metadata in the process-v2 initial single-chunk record.

Native protocol/target/media validation tests exercise IPC v4/v5 framing and rejection boundaries. The build is pinned and Windows link timestamps/debug data are disabled for deterministic release builds. The central MyWallpaper builder remains the only authority for publication, independent rebuild attestation and native admission.

Implementation follows the existing Decision Ledger, particularly DEC-0011, DEC-0012, DEC-0017, DEC-0020, DEC-0082 and DEC-0099; this README is runtime documentation, not a separate decision authority.
