import './style.css';
import { fetchSeries, fetchValue, streamVolume, type SeriesInfo } from './api';
import { Viewer, type Tool, type ViewId } from './viewer';
import type { VolumeTexture } from './renderer';
import type { Vec3 } from './math';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];

const stage = $('#stage');
const message = $('#message');
const loadStatus = $('#load-status');

function showMessage(html: string | null) {
  message.hidden = html === null;
  if (html !== null) message.innerHTML = html;
}

const viewEls = Object.fromEntries($$('.view').map((el) => [el.dataset.view, el])) as Record<ViewId, HTMLElement>;

let viewer: Viewer;
try {
  viewer = new Viewer(stage, $('#gl') as HTMLCanvasElement, $('#overlay') as HTMLCanvasElement, viewEls);
} catch (err) {
  showMessage(`<b>Cannot start the viewer.</b><br>${(err as Error).message}`);
  throw err;
}

// --- presets ---------------------------------------------------------------

// Values are close to Hounsfield units on typical dental CBCT exports (air ≈ −1000).
const WINDOW_PRESETS: Record<string, [number, number] | 'dicom'> = {
  Default: 'dicom',
  Bone: [900, 3000],
  Teeth: [1800, 3600],
  'Soft tissue': [60, 600],
  Airway: [-500, 1200],
};

const VR_PRESETS: Record<string, { mode: number; tf?: [number, number]; opacity?: number; iso?: number; tint?: Vec3 }> = {
  Bone: { mode: 0, tf: [500, 2200], opacity: 0.35 },
  Teeth: { mode: 0, tf: [1500, 3200], opacity: 0.6 },
  Skin: { mode: 2, iso: -350, tint: [0.92, 0.72, 0.62] },
  'Bone surface': { mode: 2, iso: 700, tint: [0.93, 0.89, 0.8] },
  'X-ray': { mode: 1 },
};

let series: SeriesInfo | null = null;
let range: [number, number] = [-1024, 3071];

// --- sidebar wiring --------------------------------------------------------

const wc = $<HTMLInputElement>('#wc');
const ww = $<HTMLInputElement>('#ww');
const syncWindowInputs = ([c, w]: [number, number]) => {
  wc.value = String(c);
  ww.value = String(w);
  $('#wc-out').textContent = String(Math.round(c));
  $('#ww-out').textContent = String(Math.round(w));
};
viewer.onWindowChange = syncWindowInputs;
wc.oninput = ww.oninput = () => viewer.setWindow(Number(wc.value), Number(ww.value));

for (const [name, preset] of Object.entries(WINDOW_PRESETS)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => {
    const w = preset === 'dicom' ? dicomWindow() : preset;
    viewer.setWindow(w[0], w[1]);
  };
  $('#window-presets').append(b);
}

function dicomWindow(): [number, number] {
  const c = series?.window.center;
  const w = series?.window.width;
  if (c !== undefined && w !== undefined && w > 0) return [c, w];
  return [(range[0] + range[1]) / 2, range[1] - range[0]];
}

$<HTMLInputElement>('#invert').onchange = (e) => {
  viewer.display.invert = (e.target as HTMLInputElement).checked;
  viewer.invalidate('axial', 'coronal', 'sagittal');
};
$<HTMLInputElement>('#slab').oninput = (e) => {
  viewer.display.slabMm = Number((e.target as HTMLInputElement).value);
  $('#slab-out').textContent = `${viewer.display.slabMm} mm`;
  viewer.invalidate('axial', 'coronal', 'sagittal');
};
$<HTMLSelectElement>('#slab-mode').onchange = (e) => {
  viewer.display.slabMode = Number((e.target as HTMLSelectElement).value);
  viewer.invalidate('axial', 'coronal', 'sagittal');
};

const vrMode = $<HTMLSelectElement>('#vr-mode');
const tfLo = $<HTMLInputElement>('#tf-lo');
const tfHi = $<HTMLInputElement>('#tf-hi');
const opacity = $<HTMLInputElement>('#opacity');
const iso = $<HTMLInputElement>('#iso');

function syncVolumeInputs() {
  const v = viewer.volume;
  vrMode.value = String(v.mode);
  tfLo.value = String(v.tf[0]);
  tfHi.value = String(v.tf[1]);
  opacity.value = String(v.opacity);
  iso.value = String(v.iso);
  $('#tf-lo-out').textContent = String(v.tf[0]);
  $('#tf-hi-out').textContent = String(v.tf[1]);
  $('#opacity-out').textContent = v.opacity.toFixed(2);
  $('#iso-out').textContent = String(v.iso);
  for (const el of $$('[data-mode]')) el.hidden = el.dataset.mode !== String(v.mode);
}

vrMode.onchange = () => { viewer.volume.mode = Number(vrMode.value); syncVolumeInputs(); viewer.invalidate('3d'); };
tfLo.oninput = tfHi.oninput = () => {
  const lo = Number(tfLo.value);
  const hi = Math.max(lo + 10, Number(tfHi.value));
  viewer.volume.tf = [lo, hi];
  syncVolumeInputs();
  viewer.invalidate('3d');
};
opacity.oninput = () => { viewer.volume.opacity = Number(opacity.value); syncVolumeInputs(); viewer.invalidate('3d'); };
iso.oninput = () => { viewer.volume.iso = Number(iso.value); syncVolumeInputs(); viewer.invalidate('3d'); };
$<HTMLSelectElement>('#quality').onchange = (e) => {
  viewer.volume.quality = Number((e.target as HTMLSelectElement).value);
  viewer.invalidate('3d');
};

for (const [name, p] of Object.entries(VR_PRESETS)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => {
    Object.assign(viewer.volume, { mode: p.mode }, p.tf && { tf: p.tf }, p.opacity && { opacity: p.opacity }, p.iso !== undefined && { iso: p.iso }, p.tint && { tint: p.tint });
    syncVolumeInputs();
    viewer.invalidate('3d');
  };
  $('#vr-presets').append(b);
}

for (const input of $$<HTMLInputElement>('[data-crop]')) {
  input.oninput = () => {
    const axis = Number(input.dataset.crop);
    const [minEl, maxEl] = $$<HTMLInputElement>(`[data-crop="${axis}"]`);
    const lo = Math.min(Number(minEl.value), Number(maxEl.value) - 0.01);
    const hi = Math.max(Number(maxEl.value), lo + 0.01);
    viewer.volume.cropMin[axis] = lo;
    viewer.volume.cropMax[axis] = hi;
    viewer.invalidate('3d');
  };
}

const CAMERAS: Record<string, [number, number]> = {
  front: [0, 0.12], left: [Math.PI / 2, 0.12], right: [-Math.PI / 2, 0.12],
  back: [Math.PI, 0.12], top: [0, 1.55], bottom: [0, -1.55],
};
for (const b of $$('[data-cam]')) b.onclick = () => viewer.reset3D(...CAMERAS[b.dataset.cam!]);

// Toolbar.
function setTool(t: Tool) {
  viewer.setTool(t);
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
}
for (const b of $$('[data-tool]')) b.onclick = () => setTool(b.dataset.tool as Tool);
$('#btn-reset').onclick = () => viewer.resetViews();
$('#btn-clear-measure').onclick = () => viewer.clearMeasurements();
$('#btn-shot').onclick = screenshot;

async function screenshot() {
  const blob = await viewer.screenshot();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cbct-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let hoveredView: ViewId | null = null;
for (const [id, el] of Object.entries(viewEls)) {
  el.addEventListener('pointerenter', () => (hoveredView = id as ViewId));
  el.addEventListener('pointerleave', () => (hoveredView = null));
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const tools: Record<string, Tool> = { c: 'crosshair', w: 'window', p: 'pan', z: 'zoom', m: 'measure' };
  const views: ViewId[] = ['axial', 'coronal', 'sagittal', '3d'];
  const k = e.key.toLowerCase();
  if (tools[k]) setTool(tools[k]);
  else if (k >= '1' && k <= '4') viewer.setMaximized(viewer.maximized === views[+k - 1] ? null : views[+k - 1]);
  else if (k === 'escape') viewer.setMaximized(null);
  else if (k === 'r') viewer.resetViews();
  else if (k === 's') screenshot();
  else if ((k === 'arrowup' || k === 'arrowdown') && hoveredView && hoveredView !== '3d') {
    e.preventDefault();
    viewer.scrollSlice(hoveredView, k === 'arrowup' ? 1 : -1);
  }
});

// Status bar.
let valueTimer = 0;
viewer.onCursorChange = (c) => {
  const vox = viewer.cursorVoxel();
  $('#status-cursor').textContent = `Cursor (${vox.join(', ')})  ${c.map((x) => x.toFixed(1)).join(', ')} mm`;
  clearTimeout(valueTimer);
  valueTimer = window.setTimeout(async () => {
    if (!series) return;
    const v = await fetchValue(series.uid, vox[0], vox[1], vox[2]);
    if (v !== undefined) $('#status-value').textContent = `Value ${v}`;
  }, 120);
};
viewer.onHover = (t) => ($('#status-hover').textContent = t ? `Pointer ${t}` : '');

// --- loading ---------------------------------------------------------------

const mb = (bytes: number) => `${Math.round(bytes / (1 << 20))} MB`;
let loadToken = 0;

async function loadTexture(uid: string, step: number, label: string, token: number, progressive: (t: VolumeTexture) => void): Promise<VolumeTexture | null> {
  let tex: VolumeTexture | null = null;
  try {
    await streamVolume(uid, step, {
      onHeader: (h) => {
        if (token !== loadToken) throw new Error('cancelled');
        tex = viewer.renderer.createVolume(h.dims, h.spacing, h.range);
        range = h.range;
        progressive(tex);
      },
      onSlices: (z, count, data) => {
        if (token !== loadToken) throw new Error('cancelled');
        viewer.renderer.uploadSlices(tex!, z, count, data);
        progressive(tex!);
      },
      onProgress: (f) => {
        loadStatus.textContent = `${label} ${Math.round(f * 100)}%${tex ? ` · ${mb(tex.bytes)}` : ''}`;
        const bar = message.querySelector('progress');
        if (bar) bar.value = f;
      },
    });
    return tex;
  } catch (err) {
    viewer.renderer.deleteVolume(tex);
    if ((err as Error).message !== 'cancelled') console.warn(`${label} failed`, err);
    if ((err as Error).message !== 'cancelled') loadStatus.textContent = `${label} failed: ${(err as Error).message}`;
    return null;
  }
}

async function loadSeries(s: SeriesInfo) {
  const token = ++loadToken;
  series = s;
  renderStudyInfo(s);
  viewer.renderer.deleteVolume(viewer.mprTex);
  if (viewer.vrTex !== viewer.mprTex) viewer.renderer.deleteVolume(viewer.vrTex);
  viewer.mprTex = viewer.vrTex = null;

  if (!s.supported) {
    showMessage(`<b>This series can't be displayed.</b><br>${s.unsupportedReason}`);
    return;
  }
  viewer.setGeometry(s.dims, s.spacing);
  const vrStep = Number($<HTMLSelectElement>('#vr-res').value);
  const mprStep = Number($<HTMLSelectElement>('#mpr-res').value);

  showMessage(`Reading ${s.sliceCount} slices (${s.dims.join(' × ')})…<br><small>The first load reads every DICOM file; later loads are cached.</small><progress max="1" value="0"></progress>`);
  const vr = await loadTexture(s.uid, vrStep, '3D volume', token, (t) => {
    viewer.vrTex = t;
    showMessage(null);
    viewer.invalidate();
  });
  if (token !== loadToken) return;
  if (!vr) {
    showMessage(`<b>Could not load the volume.</b><br>${loadStatus.textContent}`);
    return;
  }
  // Configure ranges once the value range is known.
  for (const el of [wc, tfLo, tfHi, iso]) { el.min = String(range[0]); el.max = String(range[1]); }
  ww.min = '1';
  ww.max = String(range[1] - range[0]);
  viewer.setWindow(...dicomWindow());
  syncVolumeInputs();

  if (mprStep === vrStep) {
    viewer.mprTex = vr;
  } else {
    const mpr = await loadTexture(s.uid, mprStep, 'Full-res slices', token, () => {});
    if (token !== loadToken) return void viewer.renderer.deleteVolume(mpr);
    if (mpr) viewer.mprTex = mpr;
    else viewer.mprTex = vr;
  }
  const total = vr.bytes + (viewer.mprTex !== vr ? viewer.mprTex.bytes : 0);
  loadStatus.textContent = `Ready · GPU ${mb(total)} · slices ${viewer.mprTex.dims.join('×')} · 3D ${vr.dims.join('×')}`;
  viewer.invalidate();
}

function renderStudyInfo(s: SeriesInfo) {
  const i = s.info;
  const fmtDate = (d?: string) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d);
  const rows: [string, string | undefined][] = [
    ['Patient', i.patientName],
    ['Born', fmtDate(i.patientBirthDate)],
    ['Sex', i.patientSex],
    ['Study', [fmtDate(i.studyDate), i.studyDescription].filter(Boolean).join(' · ')],
    ['Series', i.seriesDescription],
    ['Device', [i.manufacturer, i.model ?? i.station].filter(Boolean).join(' ')],
    ['kVp', i.kvp?.toString()],
    ['Volume', `${s.dims.join(' × ')}`],
    ['Voxel', `${s.spacing.map((x) => x.toFixed(3)).join(' × ')} mm`],
  ];
  $('#study-info').innerHTML = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v!)}</dd>`)
    .join('');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

$<HTMLSelectElement>('#mpr-res').onchange = $<HTMLSelectElement>('#vr-res').onchange = () => series && loadSeries(series);

async function init() {
  showMessage('Scanning folder for DICOM series…');
  const list = await fetchSeries();
  document.title = `${list.root} — CBCT Viewer`;
  if (list.series.length === 0) {
    showMessage(`<b>No DICOM image series found</b> in <code>${escapeHtml(list.root)}</code>.<br>Run <code>cbct-viewer</code> inside an export folder (it searches subfolders such as <code>CT/</code>).`);
    return;
  }
  const select = $<HTMLSelectElement>('#series-select');
  if (list.series.length > 1) {
    select.hidden = false;
    select.innerHTML = list.series
      .map((s, i) => `<option value="${i}">${escapeHtml(s.info.seriesDescription || s.info.studyDescription || `Series ${i + 1}`)} (${s.dims.join('×')})</option>`)
      .join('');
    select.onchange = () => loadSeries(list.series[Number(select.value)]);
  }
  // Prefer the largest supported series.
  const best = [...list.series].filter((s) => s.supported).sort((a, b) => b.dims[0] * b.dims[1] * b.dims[2] - a.dims[0] * a.dims[1] * a.dims[2])[0] ?? list.series[0];
  select.value = String(list.series.indexOf(best));
  // Pick a 3D resolution the GPU can hold.
  if (Math.max(...best.dims) / 2 > viewer.renderer.max3D) $<HTMLSelectElement>('#vr-res').value = '3';
  if (Math.max(...best.dims) > viewer.renderer.max3D) $<HTMLSelectElement>('#mpr-res').value = '2';
  await loadSeries(best);
}

init().catch((err) => showMessage(`<b>Error</b><br>${escapeHtml(String(err.message ?? err))}`));
syncVolumeInputs();
