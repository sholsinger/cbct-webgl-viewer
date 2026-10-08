# Dental CBCT export discs: format notes

Patients often get their CBCT scan on a CD/DVD or USB stick that bundles a Windows viewer
application. These notes describe the layout we've seen and which parts this tool reads.
Exact file and folder names vary by vendor and software version.

## Typical layout

```
<launcher>.exe, autorun.inf      Windows launcher that starts a bundled viewer
*.dll, platforms/, styles/       Qt / MSVC runtime for the launcher
Locale/                          gettext translations
ReadMe.txt, *_Settings.ini       viewer requirements; settings may say whether data is zipped/encrypted
CT/                              the scan: one DICOM file per axial slice  ← this is what we read
<full viewer folder>/            full vendor viewer (often a large zip), needs a dedicated GPU
  *.epf / *.prj                  project file: annotations, nerve tracing, implant plans (often a
                                 password-protected zip)
  *Setting*.xml                  sometimes encrypted, not plain XML
  *.db                           SQLite implant library
<lite viewer folder>/            lightweight viewer for low-end PCs
  *.npj                          DICOM-wrapped vendor project with private tag groups
  *.ini                          study instance UID and launch mode
```

## The CT/ series

The image data has always been standard DICOM in the exports we've seen:

| Attribute | Typical value |
| --- | --- |
| SOP class | CT Image Storage (1.2.840.10008.5.1.4.1.1.2) |
| Transfer syntax | Explicit VR Little Endian, uncompressed |
| Geometry | Square slices of several hundred pixels, isotropic voxels of 0.1–0.4 mm |
| Pixels | 16-bit signed, rescale slope 1 / intercept 0 |
| Values | roughly Hounsfield-like: air ≈ −1000, soft tissue ≈ 0–200, bone ≈ 700–2500, enamel/metal higher |
| Orientation | standard axial (IOP = [1,0,0, 0,1,0]), ImagePositionPatient z increasing superior |

CBCT intensities are not calibrated Hounsfield units, so window presets are starting points.

The viewer sorts slices by ImagePositionPatient projected onto the slice normal, and takes the
slice spacing from consecutive positions rather than SliceThickness. The volume uses DICOM patient
coordinates (+x = patient left, +y = posterior, +z = superior), so standard radiological display
conventions apply without flips.

## Proprietary files (not read)

- **Project archives** (`.epf` and similar): zip files with the traditional-encryption flag set.
  They hold the clinician's annotations and planning and need a password. This tool does not try
  to open them.
- **Lite-viewer projects** (`.npj`): DICOM Part 10 files with a private SOP class and vendor-private
  tag groups. They could hold the panoramic curve and annotations. Decoding them is possible
  future work.
- **Encrypted settings XML**: high-entropy binary.

If your disc uses a different layout or a compressed transfer syntax, please open an issue that
describes the folder structure. Don't attach any patient files.
