import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDicom, TS_EXPLICIT_LE, TS_IMPLICIT_LE } from '../src/server/dicom.js';
import { scanSeries } from '../src/server/scan.js';
import { loadVolume, downsample, toHalf } from '../src/server/volume.js';

// --- tiny DICOM writer for fixtures -----------------------------------------

const LONG = new Set(['OB', 'OW', 'SQ', 'UN', 'UT']);

function el(group, element, vr, value, explicit = true) {
  let data;
  if (Buffer.isBuffer(value)) data = value;
  else if (vr === 'US') { data = Buffer.alloc(2); data.writeUInt16LE(value); }
  else {
    data = Buffer.from(String(value), 'latin1');
    if (data.length % 2) data = Buffer.concat([data, Buffer.from(vr === 'UI' ? '\0' : ' ')]);
  }
  const tag = Buffer.alloc(4);
  tag.writeUInt16LE(group);
  tag.writeUInt16LE(element, 2);
  if (!explicit) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(data.length);
    return Buffer.concat([tag, len, data]);
  }
  if (LONG.has(vr)) {
    const hdr = Buffer.alloc(8);
    hdr.write(vr, 0, 'latin1');
    hdr.writeUInt32LE(data.length, 4);
    return Buffer.concat([tag, hdr, data]);
  }
  const hdr = Buffer.alloc(4);
  hdr.write(vr, 0, 'latin1');
  hdr.writeUInt16LE(data.length, 2);
  return Buffer.concat([tag, hdr, data]);
}

function makeSlice({ z, instance, rows = 4, cols = 3, ts = TS_EXPLICIT_LE, series = '1.2.3', fill, withSequence = false }) {
  const explicit = ts !== TS_IMPLICIT_LE;
  const meta = el(0x0002, 0x0010, 'UI', ts);
  const pixels = Buffer.alloc(rows * cols * 2);
  for (let i = 0; i < rows * cols; i++) pixels.writeInt16LE(fill(i), i * 2);
  const parts = [
    el(0x0008, 0x0060, 'CS', 'CT', explicit),
  ];
  if (withSequence && explicit) {
    // Undefined-length sequence with one undefined-length item.
    const item = Buffer.concat([
      Buffer.from([0xfe, 0xff, 0x00, 0xe0, 0xff, 0xff, 0xff, 0xff]),
      el(0x0008, 0x0100, 'SH', 'X'),
      Buffer.from([0xfe, 0xff, 0x0d, 0xe0, 0, 0, 0, 0]),
    ]);
    parts.push(Buffer.concat([
      Buffer.from([0x08, 0x00, 0x15, 0x11, 0x53, 0x51, 0, 0, 0xff, 0xff, 0xff, 0xff]),
      item,
      Buffer.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]),
    ]));
  }
  parts.push(
    el(0x0020, 0x000e, 'UI', series, explicit),
    el(0x0020, 0x0013, 'IS', instance, explicit),
    el(0x0020, 0x0032, 'DS', `0\\0\\${z}`, explicit),
    el(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0', explicit),
    el(0x0028, 0x0010, 'US', rows, explicit),
    el(0x0028, 0x0011, 'US', cols, explicit),
    el(0x0028, 0x0030, 'DS', '0.5\\0.25', explicit),
    el(0x0028, 0x0100, 'US', 16, explicit),
    el(0x0028, 0x0103, 'US', 1, explicit),
    el(0x0028, 0x1052, 'DS', '-10', explicit),
    el(0x0028, 0x1053, 'DS', '2', explicit),
    el(0x7fe0, 0x0010, 'OW', pixels, explicit),
  );
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), meta, ...parts]);
}

describe('parseDicom', () => {
  it('reads explicit VR tags and locates pixel data, skipping sequences', () => {
    const buf = makeSlice({ z: 1.5, instance: 7, fill: () => 3, withSequence: true });
    const p = parseDicom(buf);
    expect(p.transferSyntax).toBe(TS_EXPLICIT_LE);
    expect(p.tags.Rows).toBe(4);
    expect(p.tags.Columns).toBe(3);
    expect(p.tags.InstanceNumber).toBe(7);
    expect(p.tags.ImagePositionPatient).toEqual([0, 0, 1.5]);
    expect(p.tags.PixelSpacing).toEqual([0.5, 0.25]);
    expect(p.pixelData).toMatchObject({ length: 24, encapsulated: false });
    expect(buf.readInt16LE(p.pixelData.offset)).toBe(3);
  });

  it('reads implicit VR little endian', () => {
    const p = parseDicom(makeSlice({ z: 0, instance: 1, ts: TS_IMPLICIT_LE, fill: () => 0 }));
    expect(p.tags.Rows).toBe(4);
    expect(p.tags.RescaleSlope).toBe(2);
    expect(p.pixelData.length).toBe(24);
  });

  it('flags truncated headers', () => {
    const buf = makeSlice({ z: 0, instance: 1, fill: () => 0 });
    expect(parseDicom(buf.subarray(0, 200)).truncated).toBe(true);
  });

  it('rejects non-DICOM data', () => {
    expect(() => parseDicom(Buffer.from('hello world, definitely not dicom'))).toThrow();
  });
});

describe('scan + volume', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cbct-test-'));
    mkdirSync(path.join(dir, 'CT'));
    // Files written out of order; z sorting must come from ImagePositionPatient.
    for (const [file, z, inst] of [['b.dcm', 2, 3], ['a.dcm', 0, 1], ['c.dcm', 1, 2], ['d.dcm', 3, 4]]) {
      writeFileSync(path.join(dir, 'CT', file), makeSlice({ z, instance: inst, fill: (i) => z * 100 + i }));
    }
    writeFileSync(path.join(dir, 'ReadMe.txt'), 'not dicom');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('groups and sorts a series with geometry', async () => {
    const { series } = await scanSeries(dir);
    expect(series).toHaveLength(1);
    const s = series[0];
    expect(s.dims).toEqual([3, 4, 4]);
    expect(s.spacing).toEqual([0.25, 0.5, 1]);
    expect(s.files.map((f) => f.ipp[2])).toEqual([0, 1, 2, 3]);
  });

  it('loads rescaled voxels and downsamples', async () => {
    const { series } = await scanSeries(dir);
    const vol = await loadVolume(series[0]);
    // value = raw * 2 - 10, raw = z*100 + i
    expect(vol.data[0]).toBe(-10);
    expect(vol.data[12 * 2 + 5]).toBe((200 + 5) * 2 - 10);
    expect(vol.min).toBe(-10);
    const half = downsample(vol, 2);
    expect(half.dims).toEqual([1, 2, 2]);
    expect(half.spacing).toEqual([0.5, 1, 2]);
    // Block (x0..1, y0..1, z0..1): raw mean = (0+1+3+4 + 100+101+103+104)/8 = 52
    expect(half.data[0]).toBe(52 * 2 - 10);
  });
});

describe('toHalf', () => {
  it('encodes integers exactly in the half-float range', () => {
    expect(toHalf(0)).toBe(0);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(1024)).toBe(0x6400);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
  });
});
