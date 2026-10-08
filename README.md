# Desktop Panels

A MyWallpaper add-on for composing a personal desktop launcher from buttons.
Version 0.3 uses the application's sidebar and Canvas child handles for editing.
The host must implement the optional Canvas native inspector contract.

## What is implemented

- One visual add-on containing a collection of buttons, not independent sub-add-ons.
- Native sidebar properties and actions for the panel and each button, with no embedded settings editor.
- Canvas child selection, movement and resizing, using the host's handles, alignment guides and history.
- Up to 1024 buttons, with searchable lists revealed progressively.
- Rectangles with adjustable corners, ellipses, triangles and hexagons; per-button size, position, color, label and icon.
- Precise position/size fields in the sidebar, alongside direct Canvas manipulation.
- Images and muted, looping videos, including playback only on hover/focus.
- Windows file/application/shortcut/folder pickers; HTTP(S) and mailto links; optional executable/shortcut arguments.
- Read-only import from the user's and public Windows Desktop folders. Original shortcuts are never deleted, hidden or edited.
- Duplicate/delete buttons and explicit JSON import/export.

## Edit in MyWallpaper

Open the add-on's settings and choose a button in the sidebar or on the Canvas.
Its name, shape, colour, icon, action, media and precise dimensions appear in the
same native controls as other add-on settings.

The child's context menu contains file/folder/media pickers, a shortcut test,
duplicate and delete. Panel controls add a button, import selected Windows
Desktop shortcuts, adjust the surface and import/export JSON configuration.
JSON import asks for explicit replacement confirmation. The version-1 collection
and device bindings remain unchanged.
JSON import and export use the companion's Windows Open/Save dialogs; cancelling
a dialog leaves the configuration untouched. No browser download or embedded
file input is required.

## Run the optional rendering preview

Install dependencies with `pnpm install`. Use `mywallpaper dev` for real
Canvas/inspector integration. The optional `pnpm preview` at
`http://localhost:5194/?demo=1` is only a rendering aid; it does not implement a
second editor or emulate the sidebar. Demo buttons do not open real applications.

For real local targets, build the companion on Windows with Rust 1.94.1:

```powershell
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = '-C link-arg=/Brepro -C link-arg=/DEBUG:NONE'
cargo install --path native/companion --locked --target x86_64-pc-windows-msvc --root native/out/windows-x86_64 --force
node scripts/preview-bridge.mjs
```

Then open `http://localhost:5194/?demo=0`. The preview bridge is a development-only, loopback service on port 5195, restricted to the exact preview origin and an ephemeral request token. It is not shipped in the release outputs.

`pnpm build` produces the exported Canvas `mount(context)` entry. The canonical CLI uses `mywallpaper.config.json` to build the web bundle and Windows companion separately.

## Runtime and data

The Canvas layer renders the buttons. An optional inspector adapter describes
sidebar controls and returns validated settings patches; it creates no second
store or save protocol. A small Rust `process-v2` companion owns Windows Shell
file selection, directory enumeration, media reads and `ShellExecuteExW` through
existing host IPC, with no HTTP server in the published executable. No shell
command string or PowerShell/cmd intermediary is assembled.

The companion runs with ordinary user privileges after MyWallpaper's exact native add-on consent. This is not an OS sandbox or a narrow file-picker permission. Windows may independently ask for permission if the user opens an application that requires it.

The versioned layout JSON uses ordinary **layer settings**: shapes, positions, colors, names and shared URLs follow the wallpaper, so applying a wallpaper restores its creator's layout. Private application/file targets, arguments and local media paths use **device settings**, partitioned by layer and button ID. They never enter the published wallpaper. The existing host retains account, add-on source and schema isolation. Copies remain independent.

Child-target commits change only the portable layout in layer settings and use the host's existing settings history. They never serialize the merged editor view, so private device bindings stay local. If the host marks this add-on's root permanent, that same root and its layout follow the account workspace across composition changes; Desktop Panels does not copy buttons between roots.

The sidebar combines both sets of values transparently. **Export configuration**
saves a complete JSON backup, including local references; **Import configuration**
requests replacement confirmation before applying it. Exports do not embed media
files, and local references must exist on the receiving PC. Media bytes are read
only when needed; moving or deleting an original media file requires selecting
it again. Async picker results cannot commit after the account, runtime revision,
registration or selected child changes.

The layout uses a 1600 × 900 reference canvas and scales proportionally to the available layer. It does not change the browser zoom or the Windows taskbar. New installs start empty; demonstration data exists only in the preview and thumbnail modes.

## Scope

This is an ordinary add-on using the optional native inspector, Canvas, native
companion and device-settings contracts. It includes no Explorer modifications,
cross-copy synchronization service or additional storage API.

Each composition-bound root keeps the layout supplied by its wallpaper. A root the user marks permanent keeps its own layout across composition changes. JSON export/import remains the explicit way to copy a collection between roots.

Concurrent edits across different copies use the host's existing whole-value
save behavior; this version adds no conflict-resolution mechanism. Existing
Windows desktop pointer routing remains unchanged. The optional browser preview
exercises rendering and shortcut actions but does not establish native sidebar integration
or Windows desktop hit-testing behavior.

Open the preview through `http://localhost:5194/`, not by opening `index.html` as a `file://` URL: Vite serves the TypeScript modules and preview assets.

## Resource bounds and checks

Images: at most 12 MiB per source. Videos: at most 64 MiB. Native media transfers use 256 KiB chunks. The local payload/Blob cache is bounded to 96 MiB and 48 entries; visible decoded browser media uses additional memory. Offscreen videos and hidden documents are paused, and only one hover-triggered video is activated at a time. The editor caps a collection at 1024 buttons and each configuration value at 192 KiB UTF-8, leaving room for both escaped settings values and host metadata in the process-v2 initial single-chunk record.

Native protocol/target/media/configuration validation tests exercise IPC v4/v5 framing and rejection boundaries. Configuration reads are bounded even if a file grows during import.
The build is pinned and Windows link timestamps/debug data are disabled for deterministic release builds. The central MyWallpaper builder remains the only authority for publication, independent rebuild attestation and native admission.

Implementation follows the canonical MyWallpaper Decision Ledger, particularly
DEC-0013, DEC-0017, DEC-0020, DEC-0082 and DEC-0099. This README documents runtime
behavior and does not create a separate decision authority.
