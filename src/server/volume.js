import { promises as fs } from 'node:fs';

/**
 * Assemble a series into a single Int16 volume (rescaled values, e.g. HU),
 * laid out x-fastest, then y, then z.
 */
export async function loadVolume(series, onProgress) {
  const [nx, ny, nz] = series.dims;
  const sliceLen = nx * ny;
  const data = new Int16Array(sliceLen * nz);
  const bytesPerPixel = series.bitsAllocated / 8;
  const signed = series.pixelRepresentation === 1;

  const readSlice = (buf, byteOffset, z, slope, intercept) => {
    const dst = data.subarray(z * sliceLen, (z + 1) * sliceLen);
    const identity = slope === 1 && intercept === 0;
    if (bytesPerPixel === 2) {
      for (let i = 0; i < sliceLen; i++) {
        const raw = signed ? buf.readInt16LE(byteOffset + i * 2) : buf.readUInt16LE(byteOffset + i * 2);
        dst[i] = identity && signed ? raw : clamp16(raw * slope + intercept);
      }
    } else {
      for (let i = 0; i < sliceLen; i++) {
        const raw = signed ? buf.readInt8(byteOffset + i) : buf.readUInt8(byteOffset + i);
        dst[i] = clamp16(raw * slope + intercept);
      }
    }
  };

  if (series.multiframe) {
    const f = series.files[0];
    const buf = await fs.readFile(f.file);
    for (let z = 0; z < nz; z++) readSlice(buf, f.pixelOffset + z * sliceLen * bytesPerPixel, z, f.slope, f.intercept);
  } else {
    const CONCURRENCY = 16;
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < nz) {
        const z = next++;
        const f = series.files[z];
        const buf = await fs.readFile(f.file);
        readSlice(buf, f.pixelOffset, z, f.slope, f.intercept);
        done++;
        if (onProgress && done % 50 === 0) onProgress(done / nz);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  let min = 32767;
  let max = -32768;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { dims: [nx, ny, nz], spacing: [...series.spacing], data, min, max };
}

function clamp16(v) {
  v = Math.round(v);
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

/** Box-filter downsample by an integer factor along every axis. */
export function downsample(vol, step) {
  if (step <= 1) return vol;
  const [nx, ny, nz] = vol.dims;
  const ox = Math.floor(nx / step);
  const oy = Math.floor(ny / step);
  const oz = Math.floor(nz / step);
  const out = new Int16Array(ox * oy * oz);
  const acc = new Float64Array(ox * oy);
  const src = vol.data;
  const norm = 1 / (step * step * step);
  const xmap = new Int32Array(ox * step);
  for (let x = 0; x < xmap.length; x++) xmap[x] = Math.floor(x / step);

  for (let z = 0; z < oz; z++) {
    acc.fill(0);
    for (let dz = 0; dz < step; dz++) {
      const zBase = (z * step + dz) * nx * ny;
      for (let y = 0; y < oy * step; y++) {
        const rowBase = zBase + y * nx;
        const accRow = Math.floor(y / step) * ox;
        for (let x = 0; x < ox * step; x++) {
          acc[accRow + xmap[x]] += src[rowBase + x];
        }
      }
    }
    const dst = z * ox * oy;
    for (let i = 0; i < ox * oy; i++) out[dst + i] = Math.round(acc[i] * norm);
  }
  return {
    dims: [ox, oy, oz],
    spacing: vol.spacing.map((s) => s * step),
    data: out,
    min: vol.min,
    max: vol.max,
  };
}

// --- float16 encoding -------------------------------------------------------
// WebGL2 can linearly filter R16F 3D textures, so we ship voxels as half floats.
// Every int16 value maps to a fixed half, so a 64K lookup table does the work.

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >>> (1 - exp);
    return sign | ((mant + 0x1000) >>> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  // Round to nearest.
  mant += 0x1000;
  if (mant & 0x800000) {
    mant = 0;
    exp += 1;
    if (exp >= 31) return sign | 0x7c00;
  }
  return sign | (exp << 10) | (mant >>> 13);
}

let halfLut;
function getHalfLut() {
  if (!halfLut) {
    halfLut = new Uint16Array(65536);
    for (let i = 0; i < 65536; i++) halfLut[i] = toHalf(i - 32768);
  }
  return halfLut;
}

/** Encode a range of int16 voxels into a little-endian float16 buffer. */
export function encodeHalf(int16, start, end) {
  const lut = getHalfLut();
  const out = new Uint16Array(end - start);
  for (let i = start, o = 0; i < end; i++, o++) out[o] = lut[int16[i] + 32768];
  // Typed arrays use platform byte order; every supported platform is little-endian.
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}
