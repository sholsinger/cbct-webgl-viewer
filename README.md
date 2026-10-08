# cbct-webgl-viewer

View the 3D dental CBCT scan from your dentist's export disc or USB stick in any modern browser,
on macOS, Linux or Windows.

Many dental offices hand patients a CD or USB stick with a Windows-only viewer application.
If you're on a Mac, or the bundled viewer won't run, you're stuck. The scan itself is usually
plain DICOM in a folder such as `CT/`. This tool finds it and opens it in a local WebGL2 viewer
with one command.

Everything stays on your machine. The server binds to `127.0.0.1` only and never uploads anything.

> **Not a medical device. Not for diagnostic use.** This is a personal tool for viewing your own scans.
> It is not affiliated with or endorsed by any imaging equipment or software vendor.

## Usage

Requires [Node.js](https://nodejs.org) 20 or newer. Copy the disc or USB contents to a folder,
then run this inside it:

```bash
npx github:sholsinger/cbct-webgl-viewer
```

Your browser opens to the viewer. You can also pass the folder as an argument:

```bash
npx github:sholsinger/cbct-webgl-viewer "/path/to/export folder"
```

| Option | Default | |
| --- | --- | --- |
| `-p, --port <n>` | `4317` | Port (`0` = any free port) |
| `--host <addr>` | `127.0.0.1` | Interface to bind |
| `--no-open` | | Don't open a browser |

The tool searches subfolders recursively and ignores files that aren't DICOM images, such as
bundled `.exe`/`.dll` viewers. If a folder holds several series, a picker appears in the sidebar.
The first load reads every slice, which takes a few seconds for a typical scan.

## Features

- **Slices (MPR)**: axial, coronal and sagittal views with linked crosshairs, at native resolution
- **Thick slab** MIP / average / MinIP (0–40 mm), useful as a pseudo-panoramic or cephalometric view
- **3D**: GPU ray-marched volume rendering, MIP ("x-ray") and iso-surface (skin, bone), with crop
  box and camera presets
- Window/level presets for CBCT (Bone, Teeth, Soft tissue, Airway) plus the DICOM default
- Distance measurement in mm, voxel value at the cursor, PNG screenshots
- Works with any uncompressed DICOM CT/CBCT series (Explicit or Implicit VR Little Endian)

| Input | Action |
| --- | --- |
| Left-drag | Active tool (navigate / W/L / pan / zoom / measure) |
| Wheel · ⌘/Ctrl+wheel | Scroll slices · zoom |
| Right-drag · Shift/middle-drag | Window/level · pan |
| Double-click / keys 1–4 | Maximise a view |
| 3D: drag · right-drag · wheel | Orbit · pan · zoom |
| C W P Z M · R · S · ↑↓ | Tools · reset · screenshot · slice |

### Limitations

- Compressed DICOM (JPEG, JPEG 2000, RLE) is not supported yet. The viewer tells you if a series uses it.
- Full-resolution CBCT volumes can need more than 1 GB of GPU memory. If the GPU can't allocate it,
  slices fall back to half resolution. You can also pick lower resolutions in the sidebar.
- Vendor project files (annotations, implant plans, panoramic curves) are proprietary and not read.

## How it works

```
bin/cbct-viewer.js     CLI: parse args, start server, open browser
src/server/dicom.js    Minimal DICOM Part 10 parser (explicit/implicit VR LE)
src/server/scan.js     Recursively find DICOM files, group by series, sort by position
src/server/volume.js   Assemble Int16 volume, box-filter downsample, float16 encoding
src/server/server.js   HTTP: /api/series, /api/series/:uid/volume?step=N, /value; static SPA
web/src/               Vite + TypeScript SPA (no runtime dependencies)
  renderer.ts          WebGL2: R16F 3D textures, MPR and ray-march programs
  shaders.ts           GLSL: MPR/slab, DVR/MIP/iso ray marcher
  viewer.ts            View geometry, interaction, overlays, measurements
  main.ts              Sidebar UI, loading, presets
```

The server has no runtime dependencies. It streams volumes as little-endian float16 slices, which
the browser uploads straight into an `R16F` 3D texture (hardware trilinear filtering) without
keeping a second copy in JavaScript. The 3D view loads first at half resolution, then
full-resolution slices stream in.

See [docs/FORMAT.md](docs/FORMAT.md) for notes on what these export discs typically contain.

## Development

```bash
npm install                                  # also builds the web UI
CBCT_DIR="/path/to/export" npm run dev       # Vite dev server with the real /api mounted
npm test                                     # parser / volume unit tests
npm run typecheck
node bin/cbct-viewer.js "/path/to/export"    # run the built version
```

Please don't commit patient data. `*.dcm` is git-ignored, but scans can also use other extensions
or none.

## License

MIT
