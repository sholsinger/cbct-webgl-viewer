export interface SeriesInfo {
  uid: string;
  dims: [number, number, number];
  spacing: [number, number, number];
  sliceCount: number;
  window: { center?: number; width?: number };
  supported: boolean;
  unsupportedReason?: string;
  info: {
    modality?: string;
    manufacturer?: string;
    model?: string;
    station?: string;
    studyDate?: string;
    studyTime?: string;
    studyDescription?: string;
    seriesDescription?: string;
    patientName?: string;
    patientId?: string;
    patientBirthDate?: string;
    patientSex?: string;
    kvp?: number;
  };
}

export interface SeriesList {
  root: string;
  series: SeriesInfo[];
  skipped: number;
}

export interface VolumeHeader {
  dims: [number, number, number];
  spacing: [number, number, number];
  range: [number, number];
}

export async function fetchSeries(): Promise<SeriesList> {
  const res = await fetch('/api/series');
  if (!res.ok) throw new Error(`Failed to list series: ${res.status}`);
  return res.json();
}

export async function fetchValue(uid: string, x: number, y: number, z: number): Promise<number | undefined> {
  const res = await fetch(`/api/series/${encodeURIComponent(uid)}/value?x=${x}&y=${y}&z=${z}`);
  if (!res.ok) return undefined;
  return (await res.json()).value;
}

/**
 * Stream a float16 volume. `onHeader` is called once with dimensions, then
 * `onSlices` receives whole z-slices (as Uint16 half-float bits) as they arrive.
 */
export async function streamVolume(
  uid: string,
  step: number,
  handlers: {
    onHeader: (h: VolumeHeader) => void;
    onSlices: (zStart: number, count: number, data: Uint16Array) => void;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const res = await fetch(`/api/series/${encodeURIComponent(uid)}/volume?step=${step}`, { signal: handlers.signal });
  if (!res.ok || !res.body) {
    const msg = await res.json().then((j) => j.error).catch(() => res.statusText);
    throw new Error(`Volume request failed: ${msg}`);
  }
  const nums = (h: string) => (res.headers.get(h) ?? '').split(',').map(Number);
  const dims = nums('X-Volume-Dims') as [number, number, number];
  const spacing = nums('X-Volume-Spacing') as [number, number, number];
  const range = nums('X-Volume-Range') as [number, number];
  handlers.onHeader({ dims, spacing, range });

  const sliceBytes = dims[0] * dims[1] * 2;
  const total = sliceBytes * dims[2];
  // Upload in batches of ~8 MB worth of whole slices.
  const slicesPerBatch = Math.max(1, Math.floor((8 << 20) / sliceBytes));
  const staging = new Uint8Array(slicesPerBatch * sliceBytes);
  let filled = 0;
  let z = 0;
  let received = 0;

  const flush = () => {
    const count = Math.floor(filled / sliceBytes);
    if (count === 0) return;
    handlers.onSlices(z, count, new Uint16Array(staging.buffer, 0, (count * sliceBytes) / 2));
    z += count;
    const rem = filled - count * sliceBytes;
    staging.copyWithin(0, count * sliceBytes, filled);
    filled = rem;
  };

  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    let off = 0;
    while (off < value.byteLength) {
      const n = Math.min(staging.byteLength - filled, value.byteLength - off);
      staging.set(value.subarray(off, off + n), filled);
      filled += n;
      off += n;
      if (filled === staging.byteLength) flush();
    }
    handlers.onProgress?.(received / total);
  }
  flush();
  if (z !== dims[2]) throw new Error(`Volume stream ended early (${z}/${dims[2]} slices)`);
}
