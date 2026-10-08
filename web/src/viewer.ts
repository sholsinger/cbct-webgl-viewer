import { Renderer, type Rect, type VolumeTexture } from './renderer';
import { add, clamp, dot, invert, lookAt, multiply, perspective, scale, sub, type Vec3 } from './math';

export type MprId = 'axial' | 'coronal' | 'sagittal';
export type ViewId = MprId | '3d';
export type Tool = 'crosshair' | 'window' | 'pan' | 'zoom' | 'measure';

interface MprView {
  id: MprId;
  u: Vec3; // screen-right direction (world)
  v: Vec3; // screen-down direction (world)
  n: Vec3; // through-plane direction (world)
  color: string;
  pan: [number, number]; // mm offset of the view centre along u, v
  zoom: number; // device px per mm (0 = fit)
  labels: [string, string, string, string]; // left, right, top, bottom orientation markers
}

interface Measurement { view: MprId; depth: number; a: Vec3; b: Vec3 }

export interface DisplaySettings {
  window: [number, number];
  invert: boolean;
  slabMm: number;
  slabMode: number; // 0 MIP, 1 mean, 2 MinIP
}

export interface VolumeSettings {
  mode: number; // 0 DVR, 1 MIP, 2 iso
  tf: [number, number];
  opacity: number;
  iso: number;
  tint: Vec3;
  quality: number; // samples per voxel
  cropMin: Vec3;
  cropMax: Vec3;
}

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

/**
 * World space is millimetres in the volume frame: x = columns (patient left),
 * y = rows (posterior), z = slices (superior), origin at the volume corner.
 */
export class Viewer {
  renderer: Renderer;
  overlay: CanvasRenderingContext2D;
  /** Full-resolution geometry from the series header (mm per voxel, voxel counts). */
  dims: Vec3 = [1, 1, 1];
  spacing: Vec3 = [1, 1, 1];
  phys: Vec3 = [1, 1, 1];
  cursor: Vec3 = [0, 0, 0];
  mprTex: VolumeTexture | null = null;
  vrTex: VolumeTexture | null = null;

  tool: Tool = 'crosshair';
  display: DisplaySettings = { window: [2000, 7000], invert: false, slabMm: 0, slabMode: 0 };
  volume: VolumeSettings = {
    mode: 0, tf: [500, 2200], opacity: 0.35, iso: 800, tint: [0.92, 0.88, 0.8], quality: 1.5,
    cropMin: [0, 0, 0], cropMax: [1, 1, 1],
  };
  cam = { yaw: 0, pitch: 0.12, dist: 2.6, target: [0, 0, 0] as Vec3 };

  maximized: ViewId | null = null;
  measurements: Measurement[] = [];
  onCursorChange?: (c: Vec3) => void;
  onWindowChange?: (w: [number, number]) => void;
  onHover?: (text: string) => void;

  private views: Record<MprId, MprView> = {
    axial: { id: 'axial', u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], color: '#4aa3ff', pan: [0, 0], zoom: 0, labels: ['R', 'L', 'A', 'P'] },
    coronal: { id: 'coronal', u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0], color: '#5fd37a', pan: [0, 0], zoom: 0, labels: ['R', 'L', 'S', 'I'] },
    sagittal: { id: 'sagittal', u: [0, 1, 0], v: [0, 0, -1], n: [1, 0, 0], color: '#ffb547', pan: [0, 0], zoom: 0, labels: ['A', 'P', 'S', 'I'] },
  };
  private dirty = new Set<ViewId>();
  private frame = 0;
  private interacting = false;
  private interactTimer = 0;
  private pendingMeasure: { view: MprId; a: Vec3; b: Vec3 } | null = null;

  constructor(private stage: HTMLElement, private glCanvas: HTMLCanvasElement, private overlayCanvas: HTMLCanvasElement, private viewEls: Record<ViewId, HTMLElement>) {
    this.renderer = new Renderer(glCanvas);
    this.overlay = overlayCanvas.getContext('2d')!;
    new ResizeObserver(() => this.invalidate()).observe(stage);
    for (const id of Object.keys(viewEls) as ViewId[]) this.attachEvents(id, viewEls[id]);
  }

  // --- setup ---------------------------------------------------------------

  setGeometry(dims: Vec3, spacing: Vec3) {
    this.dims = dims;
    this.spacing = spacing;
    this.phys = [dims[0] * spacing[0], dims[1] * spacing[1], dims[2] * spacing[2]];
    this.cursor = scale(this.phys, 0.5);
    this.measurements = [];
    this.resetViews();
  }

  resetViews() {
    for (const v of Object.values(this.views)) { v.pan = [0, 0]; v.zoom = 0; }
    this.reset3D();
    this.invalidate();
  }

  reset3D(yaw = 0, pitch = 0.12) {
    this.cam = { yaw, pitch, dist: 2.6, target: [0, 0, 0] };
    this.invalidate('3d');
  }

  setTool(t: Tool) {
    this.tool = t;
    this.stage.dataset.tool = t;
  }

  setMaximized(id: ViewId | null) {
    this.maximized = id;
    this.stage.querySelector('#views')!.setAttribute('data-max', id ?? '');
    this.invalidate();
  }

  invalidate(...ids: ViewId[]) {
    if (ids.length === 0) ids = ['axial', 'coronal', 'sagittal', '3d'];
    for (const id of ids) this.dirty.add(id);
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  private markInteracting() {
    this.interacting = true;
    clearTimeout(this.interactTimer);
    this.interactTimer = window.setTimeout(() => {
      this.interacting = false;
      this.invalidate('3d');
    }, 180);
  }

  // --- geometry helpers ----------------------------------------------------

  private rectOf(id: ViewId): Rect | null {
    const el = this.viewEls[id];
    if (el.offsetParent === null) return null;
    const s = this.glCanvas.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const d = DPR();
    const x = Math.round((r.left - s.left) * d);
    const w = Math.round(r.width * d);
    const h = Math.round(r.height * d);
    const top = Math.round((r.top - s.top) * d);
    return { x, y: this.glCanvas.height - top - h, w, h };
  }

  private viewZoom(v: MprView, rect: Rect) {
    if (v.zoom > 0) return v.zoom;
    const eu = Math.abs(dot(v.u, this.phys));
    const ev = Math.abs(dot(v.v, this.phys));
    return 0.96 * Math.min(rect.w / eu, rect.h / ev);
  }

  /** World point at the centre of a view (depth taken from the cursor). */
  private viewCenter(v: MprView): Vec3 {
    const mid = scale(this.phys, 0.5);
    const inPlane = add(scale(v.u, dot(mid, v.u) + v.pan[0]), scale(v.v, dot(mid, v.v) + v.pan[1]));
    return add(inPlane, scale(v.n, dot(this.cursor, v.n)));
  }

  /** CSS-pixel position within a view → world mm. */
  private screenToWorld(id: MprId, px: number, py: number): Vec3 {
    const v = this.views[id];
    const rect = this.rectOf(id)!;
    const d = DPR();
    const z = this.viewZoom(v, rect);
    const c = this.viewCenter(v);
    return add(c, add(scale(v.u, (px * d - rect.w / 2) / z), scale(v.v, (py * d - rect.h / 2) / z)));
  }

  /** World mm → device-pixel position within the view rect (top-left origin). */
  private worldToScreen(id: MprId, p: Vec3, rect: Rect): [number, number] {
    const v = this.views[id];
    const z = this.viewZoom(v, rect);
    const rel = sub(p, this.viewCenter(v));
    return [rect.w / 2 + dot(rel, v.u) * z, rect.h / 2 + dot(rel, v.v) * z];
  }

  private clampCursor(p: Vec3): Vec3 {
    return [clamp(p[0], 0, this.phys[0] - 1e-3), clamp(p[1], 0, this.phys[1] - 1e-3), clamp(p[2], 0, this.phys[2] - 1e-3)];
  }

  setCursor(p: Vec3) {
    this.cursor = this.clampCursor(p);
    this.onCursorChange?.(this.cursor);
    this.invalidate('axial', 'coronal', 'sagittal');
  }

  cursorVoxel(): Vec3 {
    return this.cursor.map((c, i) => clamp(Math.floor(c / this.spacing[i]), 0, this.dims[i] - 1)) as Vec3;
  }

  sliceIndex(id: MprId): [number, number] {
    const v = this.views[id];
    const axis = v.n.findIndex((c) => c !== 0);
    return [Math.floor(this.cursor[axis] / this.spacing[axis]) + 1, this.dims[axis]];
  }

  scrollSlice(id: MprId, delta: number) {
    const v = this.views[id];
    const axis = v.n.findIndex((c) => c !== 0);
    this.setCursor(add(this.cursor, scale(v.n, delta * this.spacing[axis])));
  }

  setWindow(center: number, width: number) {
    this.display.window = [center, Math.max(1, width)];
    this.onWindowChange?.(this.display.window);
    this.invalidate('axial', 'coronal', 'sagittal');
    if (this.volume.mode === 1) this.invalidate('3d');
  }

  // --- rendering -----------------------------------------------------------

  private render() {
    this.frame = 0;
    const d = DPR();
    const sr = this.stage.getBoundingClientRect();
    const w = Math.round(sr.width * d);
    const h = Math.round(sr.height * d);
    if (this.glCanvas.width !== w || this.glCanvas.height !== h) {
      this.renderer.resize(w, h);
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
      this.dirty = new Set(['axial', 'coronal', 'sagittal', '3d']);
    }
    if (this.dirty.size === 4) this.renderer.clear();

    for (const id of this.dirty) {
      const rect = this.rectOf(id);
      if (!rect || rect.w < 2 || rect.h < 2) continue;
      if (id === '3d') this.draw3D(rect);
      else this.drawMpr(id, rect);
    }
    this.dirty.clear();
    this.drawOverlay();
  }

  private drawMpr(id: MprId, rect: Rect) {
    const tex = this.mprTex ?? this.vrTex;
    if (!tex) return;
    const v = this.views[id];
    const z = this.viewZoom(v, rect);
    const tcPerMm: Vec3 = [1 / this.phys[0], 1 / this.phys[1], 1 / this.phys[2]];
    const mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
    const axis = v.n.findIndex((c) => c !== 0);
    const texStepMm = this.phys[axis] / tex.dims[axis];
    const slabSteps = this.display.slabMm > 0 ? Math.min(128, Math.round(this.display.slabMm / 2 / texStepMm)) : 0;
    this.renderer.drawMpr(rect, tex, {
      origin: mul(this.viewCenter(v), tcPerMm),
      du: mul(scale(v.u, 1 / z), tcPerMm),
      dv: mul(scale(v.v, 1 / z), tcPerMm),
      dn: mul(scale(v.n, texStepMm), tcPerMm),
      slabSteps,
      slabMode: this.display.slabMode,
      window: this.display.window,
      invert: this.display.invert,
    });
  }

  private boxSize(): Vec3 {
    const m = Math.max(...this.phys);
    return [this.phys[0] / m, this.phys[1] / m, this.phys[2] / m];
  }

  private cameraEye(): Vec3 {
    const { yaw, pitch, dist, target } = this.cam;
    const dir: Vec3 = [Math.sin(yaw) * Math.cos(pitch), -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
    return add(target, scale(dir, dist));
  }

  private draw3D(rect: Rect) {
    const tex = this.vrTex ?? this.mprTex;
    if (!tex) return;
    const eye = this.cameraEye();
    const view = lookAt(eye, this.cam.target, [0, 0, 1]);
    const proj = perspective((28 * Math.PI) / 180, rect.w / rect.h, 0.01, 20);
    const box = this.boxSize();
    const refStep = box[0] / tex.dims[0];
    const fast = this.interacting;
    const vs = this.volume;
    this.renderer.drawVolume(rect, tex, {
      invViewProj: invert(multiply(proj, view)),
      camPos: eye,
      boxSize: box,
      cropMin: vs.cropMin,
      cropMax: vs.cropMax,
      step: refStep / (fast ? Math.min(vs.quality, 0.75) : vs.quality),
      refStep,
      mode: vs.mode,
      window: this.display.window,
      tf: vs.tf,
      opacity: vs.opacity,
      iso: vs.iso,
      tint: vs.tint,
      resolutionScale: fast ? 0.5 : 1,
    });
  }

  private drawOverlay() {
    const ctx = this.overlay;
    const d = DPR();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    const H = this.overlayCanvas.height;
    ctx.font = `${12 * d}px ui-sans-serif, system-ui, sans-serif`;

    for (const id of ['axial', 'coronal', 'sagittal'] as MprId[]) {
      const rect = this.rectOf(id);
      if (!rect) continue;
      const top = H - rect.y - rect.h;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, top, rect.w, rect.h);
      ctx.clip();
      ctx.translate(rect.x, top);

      const v = this.views[id];
      const [cx, cy] = this.worldToScreen(id, this.cursor, rect);
      // Crosshair lines are coloured by the plane they represent.
      const gap = 14 * d;
      for (const other of Object.values(this.views)) {
        if (other.id === id) continue;
        ctx.strokeStyle = other.color;
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = d;
        ctx.beginPath();
        if (Math.abs(dot(other.n, v.u)) > 0.5) {
          ctx.moveTo(cx, 0); ctx.lineTo(cx, cy - gap); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, rect.h);
        } else {
          ctx.moveTo(0, cy); ctx.lineTo(cx - gap, cy); ctx.moveTo(cx + gap, cy); ctx.lineTo(rect.w, cy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Measurements on this slice.
      const depth = dot(this.cursor, v.n);
      const axis = v.n.findIndex((c) => c !== 0);
      const tol = this.spacing[axis] * 0.5 + 1e-6;
      const list = this.measurements.filter((m) => m.view === id && Math.abs(m.depth - depth) <= tol);
      if (this.pendingMeasure?.view === id) list.push({ ...this.pendingMeasure, depth });
      for (const m of list) this.drawMeasurement(ctx, id, rect, m.a, m.b, d);

      // Labels.
      ctx.fillStyle = v.color;
      ctx.fillText(id.toUpperCase(), 8 * d, 18 * d);
      const [si, sn] = this.sliceIndex(id);
      ctx.fillStyle = '#c9d1d9';
      const slab = this.display.slabMm > 0 ? `  slab ${this.display.slabMm.toFixed(1)} mm ${['MIP', 'AVG', 'MinIP'][this.display.slabMode]}` : '';
      ctx.fillText(`${si} / ${sn}${slab}`, 8 * d, rect.h - 10 * d);
      const wl = `W ${Math.round(this.display.window[1])}  L ${Math.round(this.display.window[0])}`;
      ctx.fillText(wl, rect.w - ctx.measureText(wl).width - 8 * d, rect.h - 10 * d);
      ctx.fillStyle = 'rgba(230,237,243,0.75)';
      const [l, r, t, b] = v.labels;
      ctx.fillText(l, 8 * d, rect.h / 2);
      ctx.fillText(r, rect.w - 16 * d, rect.h / 2);
      ctx.fillText(t, rect.w / 2, 18 * d);
      ctx.fillText(b, rect.w / 2, rect.h - 28 * d);
      // Scale bar: 10 mm.
      const z = this.viewZoom(v, rect);
      ctx.strokeStyle = '#c9d1d9';
      ctx.beginPath();
      const x0 = rect.w - 20 * d - 10 * z;
      ctx.moveTo(x0, 28 * d); ctx.lineTo(x0 + 10 * z, 28 * d);
      ctx.stroke();
      ctx.fillText('10 mm', x0, 22 * d);
      ctx.restore();
    }

    const r3 = this.rectOf('3d');
    if (r3) {
      ctx.fillStyle = '#e6edf3';
      ctx.fillText('3D', r3.x + 8 * d, H - r3.y - r3.h + 18 * d);
    }
  }

  private drawMeasurement(ctx: CanvasRenderingContext2D, id: MprId, rect: Rect, a: Vec3, b: Vec3, d: number) {
    const [ax, ay] = this.worldToScreen(id, a, rect);
    const [bx, by] = this.worldToScreen(id, b, rect);
    ctx.strokeStyle = '#ffe14d';
    ctx.fillStyle = '#ffe14d';
    ctx.lineWidth = 1.5 * d;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      ctx.beginPath();
      ctx.arc(x, y, 3 * d, 0, Math.PI * 2);
      ctx.fill();
    }
    const len = Math.hypot(...sub(b, a));
    const label = `${len.toFixed(1)} mm`;
    ctx.font = `bold ${12 * d}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const tw = ctx.measureText(label).width;
    ctx.fillRect(bx + 6 * d, by - 16 * d, tw + 8 * d, 18 * d);
    ctx.fillStyle = '#ffe14d';
    ctx.fillText(label, bx + 10 * d, by - 3 * d);
    ctx.font = `${12 * d}px ui-sans-serif, system-ui, sans-serif`;
  }

  clearMeasurements() {
    this.measurements = [];
    this.invalidate('axial', 'coronal', 'sagittal');
  }

  /** Composite the GL and overlay canvases into a PNG blob. */
  async screenshot(): Promise<Blob> {
    this.dirty = new Set(['axial', 'coronal', 'sagittal', '3d']);
    this.render();
    const c = document.createElement('canvas');
    c.width = this.glCanvas.width;
    c.height = this.glCanvas.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(this.glCanvas, 0, 0);
    ctx.drawImage(this.overlayCanvas, 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  }

  // --- interaction ---------------------------------------------------------

  private attachEvents(id: ViewId, el: HTMLElement) {
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dblclick', () => this.setMaximized(this.maximized === id ? null : id));

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (id === '3d') {
        this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.0015), 0.3, 10);
        this.markInteracting();
        this.invalidate('3d');
        return;
      }
      const v = this.views[id];
      if (e.ctrlKey || e.metaKey) {
        const rect = this.rectOf(id)!;
        const before = this.screenToWorld(id, e.offsetX, e.offsetY);
        v.zoom = clamp(this.viewZoom(v, rect) * Math.exp(-e.deltaY * 0.01), 0.2, 200);
        // Keep the point under the mouse fixed.
        const after = this.screenToWorld(id, e.offsetX, e.offsetY);
        const delta = sub(before, after);
        v.pan = [v.pan[0] + dot(delta, v.u), v.pan[1] + dot(delta, v.v)];
        this.invalidate(id);
      } else {
        const steps = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40));
        this.scrollSlice(id, steps);
      }
    }, { passive: false });

    el.addEventListener('pointermove', (e) => {
      if (id !== '3d' && this.onHover && this.mprTex) {
        const w = this.screenToWorld(id, e.offsetX, e.offsetY);
        const vox = w.map((c, i) => Math.floor(c / this.spacing[i]));
        const inside = vox.every((c, i) => c >= 0 && c < this.dims[i]);
        this.onHover(inside ? `(${vox.join(', ')})  ${w.map((c) => c.toFixed(1)).join(', ')} mm` : '');
      }
    });

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const start = { x: e.offsetX, y: e.offsetY };
      let last = { ...start };
      const button = e.button;
      const mode: Tool | 'orbit' =
        id === '3d'
          ? (button === 2 || button === 1 || e.shiftKey ? 'pan' : 'orbit')
          : button === 2 ? 'window'
          : button === 1 || e.shiftKey ? 'pan'
          : this.tool;
      const startWindow = [...this.display.window] as [number, number];
      const mpr = id !== '3d' ? this.views[id] : null;

      if (mpr && mode === 'crosshair') this.setCursor(this.screenToWorld(id as MprId, e.offsetX, e.offsetY));
      if (mpr && mode === 'measure') {
        const p = this.screenToWorld(id as MprId, e.offsetX, e.offsetY);
        this.pendingMeasure = { view: id as MprId, a: p, b: p };
      }

      const move = (ev: PointerEvent) => {
        const dx = ev.offsetX - last.x;
        const dy = ev.offsetY - last.y;
        last = { x: ev.offsetX, y: ev.offsetY };
        if (id === '3d') {
          this.markInteracting();
          if (mode === 'orbit') {
            this.cam.yaw -= dx * 0.008;
            this.cam.pitch = clamp(this.cam.pitch + dy * 0.008, -1.55, 1.55);
          } else {
            const scaleF = this.cam.dist * 0.0015;
            const yaw = this.cam.yaw;
            const right: Vec3 = [Math.cos(yaw), Math.sin(yaw), 0];
            const up: Vec3 = [0, 0, 1];
            this.cam.target = add(this.cam.target, add(scale(right, -dx * scaleF), scale(up, dy * scaleF)));
          }
          this.invalidate('3d');
          return;
        }
        const v = mpr!;
        const rect = this.rectOf(id)!;
        const z = this.viewZoom(v, rect);
        const d = DPR();
        switch (mode) {
          case 'crosshair':
            this.setCursor(this.screenToWorld(id, ev.offsetX, ev.offsetY));
            break;
          case 'pan':
            v.pan = [v.pan[0] - (dx * d) / z, v.pan[1] - (dy * d) / z];
            this.invalidate(id);
            break;
          case 'zoom':
            v.zoom = clamp(z * Math.exp(-dy * 0.01), 0.2, 200);
            this.invalidate(id);
            break;
          case 'window': {
            const tx = ev.offsetX - start.x;
            const ty = ev.offsetY - start.y;
            const sens = Math.max(startWindow[1], 200) / 300;
            this.setWindow(startWindow[0] + ty * sens, startWindow[1] + tx * sens * 2);
            break;
          }
          case 'measure':
            this.pendingMeasure!.b = this.screenToWorld(id, ev.offsetX, ev.offsetY);
            this.invalidate(id);
            break;
        }
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (this.pendingMeasure) {
          const m = this.pendingMeasure;
          this.pendingMeasure = null;
          if (Math.hypot(...sub(m.b, m.a)) > 0.3) {
            this.measurements.push({ view: m.view, depth: dot(this.cursor, this.views[m.view].n), a: m.a, b: m.b });
          }
          this.invalidate(id);
        }
        if (id === '3d') this.markInteracting();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
}
