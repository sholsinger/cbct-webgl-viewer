import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { scanSeries, describeSeries } from './scan.js';
import { loadVolume, downsample, encodeHalf } from './volume.js';

/**
 * Build the /api request handler for a data folder.
 * Returns `handle(req, res)` which resolves to true when it handled the request.
 */
export function createApi(root, { log = console.log } = {}) {
  let scanPromise;
  const scan = () => {
    scanPromise ??= (async () => {
      const t0 = Date.now();
      const result = await scanSeries(root);
      log(`Found ${result.series.length} series in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return result;
    })();
    return scanPromise;
  };

  // Only one series is held in memory at a time (full-res CBCT volumes are ~1 GB).
  let cache = { uid: null, full: null, levels: new Map() };
  const getVolume = async (series, step) => {
    if (cache.uid !== series.uid) cache = { uid: series.uid, full: null, levels: new Map() };
    const c = cache;
    c.full ??= (async () => {
      const t0 = Date.now();
      log(`Loading ${series.files.length} slices (${series.dims.join('×')})…`);
      const vol = await loadVolume(series);
      log(`Volume loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s, range [${vol.min}, ${vol.max}]`);
      return vol;
    })();
    if (step <= 1) return c.full;
    if (!c.levels.has(step)) c.levels.set(step, c.full.then((v) => downsample(v, step)));
    return c.levels.get(step);
  };

  const findSeries = async (uid) => {
    const { series } = await scan();
    return series.find((s) => s.uid === uid);
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      if (url.pathname === '/api/series') {
        const { series, skipped } = await scan();
        sendJson(res, { root: path.basename(path.resolve(root)), series: series.map(describeSeries), skipped: skipped.length });
        return true;
      }

      const m = url.pathname.match(/^\/api\/series\/([^/]+)\/(volume|value)$/);
      if (m) {
        const series = await findSeries(decodeURIComponent(m[1]));
        if (!series) return sendJson(res, { error: 'Series not found' }, 404), true;
        if (!describeSeries(series).supported) return sendJson(res, { error: describeSeries(series).unsupportedReason }, 415), true;

        if (m[2] === 'value') {
          const vol = await getVolume(series, 1);
          const [x, y, z] = ['x', 'y', 'z'].map((k) => Number(url.searchParams.get(k)));
          const [nx, ny, nz] = vol.dims;
          if (![x, y, z].every(Number.isInteger) || x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) {
            return sendJson(res, { error: 'Out of range' }, 400), true;
          }
          sendJson(res, { value: vol.data[x + nx * (y + ny * z)] });
          return true;
        }

        const step = Math.max(1, Math.min(8, parseInt(url.searchParams.get('step') ?? '1', 10) || 1));
        const vol = await getVolume(series, step);
        await streamVolume(res, vol);
        return true;
      }

      sendJson(res, { error: 'Not found' }, 404);
    } catch (err) {
      log(`Error handling ${url.pathname}: ${err.stack ?? err}`);
      if (!res.headersSent) sendJson(res, { error: String(err.message ?? err) }, 500);
      else res.destroy(err);
    }
    return true;
  }

  return { handle, scan };
}

async function streamVolume(res, vol) {
  const [nx, ny, nz] = vol.dims;
  const slice = nx * ny;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(slice * nz * 2),
    'Cache-Control': 'no-store',
    'X-Volume-Dims': vol.dims.join(','),
    'X-Volume-Spacing': vol.spacing.join(','),
    'X-Volume-Range': `${vol.min},${vol.max}`,
    'X-Volume-Format': 'float16-le',
    'Access-Control-Expose-Headers': 'X-Volume-Dims, X-Volume-Spacing, X-Volume-Range, X-Volume-Format',
  });
  // Send a handful of slices per chunk, respecting backpressure.
  const slicesPerChunk = Math.max(1, Math.floor((4 << 20) / (slice * 2)));
  for (let z = 0; z < nz; z += slicesPerChunk) {
    if (res.destroyed) return;
    const end = Math.min(nz, z + slicesPerChunk);
    const ok = res.write(encodeHalf(vol.data, z * slice, end * slice));
    if (!ok) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

function sendJson(res, body, status = 200) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(json);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Static file server for the built SPA with index.html fallback. */
export function createStatic(webRoot) {
  const rootResolved = path.resolve(webRoot);
  return async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(rootResolved, '.' + rel);
    if (!file.startsWith(rootResolved + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    let stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      file = path.join(rootResolved, 'index.html');
      stat = await fs.stat(file).catch(() => null);
      if (!stat) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Web UI not built. Run `npm run build`.');
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  };
}

export function startServer({ root, webRoot, host = '127.0.0.1', port = 0, log = console.log }) {
  const api = createApi(root, { log });
  const serveStatic = createStatic(webRoot);
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (await api.handle(req, res)) return;
    await serveStatic(req, res);
  });
  // Kick off the folder scan immediately so it's ready when the browser asks.
  api.scan();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, api, address: server.address() }));
  });
}
