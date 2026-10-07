# Desktop Panels

A MyWallpaper add-on for composing a personal desktop launcher from web buttons. This checkout is a local preview, not a published release.

## What is implemented

- One visual add-on containing a collection of buttons, not independent sub-add-ons.
- A visual editor opened by **Manage buttons** in the existing MyWallpaper settings.
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

Versioned button JSON is stored in the SDK's **device settings**, partitioned by stable layer ID. Copies remain independent, and paths/arguments/media references are not cloud-synced. The settings mechanism retains its existing account, add-on source and schema isolation. Media bytes are read only when needed; moving or deleting an original media file requires selecting it again. Explicit JSON exports contain local paths and should be shared deliberately.

The layout uses a 1600 × 900 reference canvas and scales proportionally to the available layer. It does not change the browser zoom or the Windows taskbar. New installs start empty; demonstration data exists only in the preview and thumbnail modes.

## Current Desktop integration limit

The existing Canvas API makes buttons DOM-interactive (`pointerEvents: auto`). The current Windows desktop host additionally filters discrete clicks/wheels through host-owned interaction rectangles; add-ons do not currently publish those regions. Consequently, functionality in the interface or standalone preview does **not** establish that these buttons receive clicks in wallpaper mode beneath Explorer.

The add-on does not bypass this host filter, install global input hooks, or modify Explorer. Completing that desktop integration requires a generic host input-routing correction using the existing layer pointer policy. Routing alone is insufficient: the current transparent desktop window can also leave the physical click to Explorer, potentially activating an icon behind a web button. Input ownership must therefore be qualified against actual Windows desktop icons, including overlapping controls and single/double clicks, rather than simply forwarding more events. This remains outside this add-on checkout. Do not publish it as a complete desktop replacement until that path is qualified.

The current public device-settings API also replaces a whole setting value without a compare-and-swap/record-merge operation. The per-layer JSON partition prevents ordinary copies from sharing a layout, but concurrent saves from separate copies can overwrite a stale aggregate. Editing one copy at a time is sufficient for this local exploration; publication must first qualify a generic atomic settings mechanism rather than add an ad-hoc synchronization protocol or a launcher-specific Core store.

## Resource bounds and checks

Images: at most 12 MiB per source. Videos: at most 64 MiB. Native media transfers use 256 KiB chunks. The local payload/Blob cache is bounded to 96 MiB and 48 entries; visible decoded browser media uses additional memory. Offscreen videos and hidden documents are paused, and only one hover-triggered video is activated at a time. The editor caps a collection at 1024 buttons and device data at 512 KiB UTF-8 to bound serialization and leave room for host metadata in the process-v2 initial single-chunk record.

Native protocol/target/media validation tests exercise IPC v4/v5 framing and rejection boundaries. The build is pinned and Windows link timestamps/debug data are disabled for deterministic release builds. The central MyWallpaper builder remains the only authority for publication, independent rebuild attestation and native admission.

Implementation follows the existing Decision Ledger, particularly DEC-0011, DEC-0012, DEC-0017, DEC-0020, DEC-0082 and DEC-0099; this README is runtime documentation, not a separate decision authority.
