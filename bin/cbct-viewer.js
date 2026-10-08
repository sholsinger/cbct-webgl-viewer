#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { startServer } from '../src/server/server.js';

const HELP = `Usage: cbct-viewer [folder] [options]

Serve a local WebGL viewer for the DICOM CT/CBCT data in [folder]
(default: current directory), e.g. a dental CBCT patient export disc or USB stick.

Options:
  -p, --port <n>     Port to listen on (default: 4317, 0 = any free port)
      --host <addr>  Interface to bind (default: 127.0.0.1 — local only)
      --no-open      Don't open a browser window
  -h, --help         Show this help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p', default: '4317' },
    host: { type: 'string', default: '127.0.0.1' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const root = path.resolve(positionals[0] ?? process.cwd());
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/web');

async function listen(port) {
  try {
    return await startServer({ root, webRoot, host: values.host, port });
  } catch (err) {
    if (err.code === 'EADDRINUSE' && port !== 0) {
      console.log(`Port ${port} is busy, picking a free one…`);
      return startServer({ root, webRoot, host: values.host, port: 0 });
    }
    throw err;
  }
}

const { address } = await listen(Number(values.port));
const shownHost = values.host === '0.0.0.0' || values.host === '::' ? 'localhost' : values.host;
const url = `http://${shownHost}:${address.port}/`;
console.log(`CBCT viewer serving ${root}`);
console.log(`→ ${url}   (Ctrl+C to stop)`);

if (!values['no-open']) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
