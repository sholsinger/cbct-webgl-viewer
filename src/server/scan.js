import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDicom } from './dicom.js';

const HEADER_PROBE_BYTES = 64 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'Locale', 'platforms', 'styles', 'vcredist']);
const SKIP_EXT = new Set(['.dll', '.exe', '.zip', '.txt', '.ini', '.inf', '.xml', '.db', '.mo', '.qss', '.html', '.js', '.css']);

async function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, depth + 1);
    } else if (e.isFile()) {
      if (!SKIP_EXT.has(path.extname(e.name).toLowerCase())) yield full;
    }
  }
}

async function readHeader(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const probe = Buffer.alloc(Math.min(size, HEADER_PROBE_BYTES));
    await fh.read(probe, 0, probe.length, 0);
    let parsed = parseDicom(probe);
    // Header larger than the probe (long private tags, embedded thumbnails…): read everything.
    if (parsed.truncated && !parsed.pixelData && size > probe.length) {
      const all = await fh.readFile();
      parsed = parseDicom(all);
    }
    return { parsed, size };
  } finally {
    await fh.close();
  }
}

/**
 * Recursively find DICOM image files under `root` and group them into series.
 * @param {string} root
 * @param {(n:number)=>void} [onProgress]
 */
export async function scanSeries(root, onProgress) {
  const series = new Map();
  const skipped = [];
  let seen = 0;

  const files = [];
  for await (const f of walk(root)) files.push(f);

  const CONCURRENCY = 32;
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      try {
        const { parsed } = await readHeader(file);
        const t = parsed.tags;
        if (!parsed.pixelData || !t.SeriesInstanceUID || !t.Rows || !t.Columns) continue;
        let s = series.get(t.SeriesInstanceUID);
        if (!s) {
          s = { uid: t.SeriesInstanceUID, tags: t, transferSyntax: parsed.transferSyntax, files: [] };
          series.set(t.SeriesInstanceUID, s);
        }
        s.files.push({
          file,
          instance: t.InstanceNumber ?? 0,
          ipp: t.ImagePositionPatient,
          pixelOffset: parsed.pixelData.offset,
          pixelLength: parsed.pixelData.length,
          encapsulated: parsed.pixelData.encapsulated,
          frames: t.NumberOfFrames ?? 1,
          slope: t.RescaleSlope ?? 1,
          intercept: t.RescaleIntercept ?? 0,
        });
      } catch (err) {
        skipped.push({ file, reason: err.message });
      } finally {
        seen++;
        if (onProgress && seen % 100 === 0) onProgress(seen);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return { series: [...series.values()].map(finalizeSeries).filter(Boolean), skipped };
}

function finalizeSeries(s) {
  const t = s.tags;
  const iop = Array.isArray(t.ImageOrientationPatient) && t.ImageOrientationPatient.length === 6
    ? t.ImageOrientationPatient
    : [1, 0, 0, 0, 1, 0];
  const row = iop.slice(0, 3);
  const col = iop.slice(3, 6);
  const normal = [
    row[1] * col[2] - row[2] * col[1],
    row[2] * col[0] - row[0] * col[2],
    row[0] * col[1] - row[1] * col[0],
  ];
  const along = (f) => (Array.isArray(f.ipp) ? f.ipp[0] * normal[0] + f.ipp[1] * normal[1] + f.ipp[2] * normal[2] : f.instance);
  s.files.sort((a, b) => along(a) - along(b) || a.instance - b.instance);

  const spacing2d = Array.isArray(t.PixelSpacing) ? t.PixelSpacing : [1, 1];
  let sliceSpacing = t.SliceThickness || 1;
  if (s.files.length > 1 && Array.isArray(s.files[0].ipp)) {
    const d = (along(s.files[s.files.length - 1]) - along(s.files[0])) / (s.files.length - 1);
    if (Math.abs(d) > 1e-6) sliceSpacing = Math.abs(d);
  }

  const multiframe = s.files.length === 1 && s.files[0].frames > 1;
  const depth = multiframe ? s.files[0].frames : s.files.length;
  const encapsulated = s.files.some((f) => f.encapsulated);

  return {
    uid: s.uid,
    files: s.files,
    multiframe,
    encapsulated,
    transferSyntax: s.transferSyntax,
    // Volume axes: x = columns (row direction), y = rows (column direction), z = slice normal.
    dims: [t.Columns, t.Rows, depth],
    // PixelSpacing is [row spacing, column spacing] = [y, x].
    spacing: [spacing2d[1], spacing2d[0], sliceSpacing],
    orientation: { row, col, normal },
    origin: Array.isArray(s.files[0].ipp) ? s.files[0].ipp : [0, 0, 0],
    bitsAllocated: t.BitsAllocated ?? 16,
    pixelRepresentation: t.PixelRepresentation ?? 0,
    samplesPerPixel: t.SamplesPerPixel ?? 1,
    window: { center: first(t.WindowCenter), width: first(t.WindowWidth) },
    info: {
      modality: t.Modality,
      manufacturer: t.Manufacturer,
      model: t.ManufacturerModelName,
      station: t.StationName,
      studyDate: t.StudyDate,
      studyTime: t.StudyTime,
      studyDescription: t.StudyDescription,
      seriesDescription: t.SeriesDescription,
      seriesNumber: t.SeriesNumber,
      patientName: t.PatientName?.replace(/\^/g, ' ').trim(),
      patientId: t.PatientID,
      patientBirthDate: t.PatientBirthDate,
      patientSex: t.PatientSex,
      kvp: t.KVP,
      photometric: t.PhotometricInterpretation,
    },
  };
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

/** Public, JSON-safe description of a series. */
export function describeSeries(s) {
  const supported = !s.encapsulated && s.samplesPerPixel === 1 && (s.bitsAllocated === 16 || s.bitsAllocated === 8);
  return {
    uid: s.uid,
    dims: s.dims,
    spacing: s.spacing,
    orientation: s.orientation,
    origin: s.origin,
    sliceCount: s.files.length,
    window: s.window,
    info: s.info,
    supported,
    unsupportedReason: supported
      ? undefined
      : s.encapsulated
        ? `Compressed transfer syntax (${s.transferSyntax}) is not supported yet`
        : 'Only single-channel 8/16-bit images are supported',
  };
}
