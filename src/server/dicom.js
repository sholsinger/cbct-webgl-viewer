// Minimal DICOM Part 10 reader: enough to index CT/CBCT series and locate
// uncompressed pixel data. Supports Explicit VR Little Endian and Implicit VR
// Little Endian. Compressed (encapsulated) pixel data is reported, not decoded.

export const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
export const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
export const TS_DEFLATED_LE = '1.2.840.10008.1.2.1.99';
export const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';

const PIXEL_DATA = 0x7fe00010;
const ITEM = 0xfffee000;
const ITEM_DELIM = 0xfffee00d;
const SEQ_DELIM = 0xfffee0dd;
const UNDEFINED = 0xffffffff;

// VRs whose explicit-VR header uses 2 reserved bytes + a 4-byte length.
const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);

// Tags we pull out of each file, with the VR used when the file is implicit VR.
export const TAGS = {
  0x00080060: ['Modality', 'CS'],
  0x00080020: ['StudyDate', 'DA'],
  0x00080030: ['StudyTime', 'TM'],
  0x00080070: ['Manufacturer', 'LO'],
  0x00081090: ['ManufacturerModelName', 'LO'],
  0x00081010: ['StationName', 'SH'],
  0x00081030: ['StudyDescription', 'LO'],
  0x0008103e: ['SeriesDescription', 'LO'],
  0x00080016: ['SOPClassUID', 'UI'],
  0x00100010: ['PatientName', 'PN'],
  0x00100020: ['PatientID', 'LO'],
  0x00100030: ['PatientBirthDate', 'DA'],
  0x00100040: ['PatientSex', 'CS'],
  0x00180050: ['SliceThickness', 'DS'],
  0x00180060: ['KVP', 'DS'],
  0x0020000d: ['StudyInstanceUID', 'UI'],
  0x0020000e: ['SeriesInstanceUID', 'UI'],
  0x00200011: ['SeriesNumber', 'IS'],
  0x00200013: ['InstanceNumber', 'IS'],
  0x00200032: ['ImagePositionPatient', 'DS'],
  0x00200037: ['ImageOrientationPatient', 'DS'],
  0x00280002: ['SamplesPerPixel', 'US'],
  0x00280004: ['PhotometricInterpretation', 'CS'],
  0x00280008: ['NumberOfFrames', 'IS'],
  0x00280010: ['Rows', 'US'],
  0x00280011: ['Columns', 'US'],
  0x00280030: ['PixelSpacing', 'DS'],
  0x00280100: ['BitsAllocated', 'US'],
  0x00280101: ['BitsStored', 'US'],
  0x00280103: ['PixelRepresentation', 'US'],
  0x00281050: ['WindowCenter', 'DS'],
  0x00281051: ['WindowWidth', 'DS'],
  0x00281052: ['RescaleIntercept', 'DS'],
  0x00281053: ['RescaleSlope', 'DS'],
};

const latin1 = new TextDecoder('latin1');

function decodeValue(buf, off, len, vr) {
  switch (vr) {
    case 'US':
      return len >= 2 ? buf.readUInt16LE(off) : undefined;
    case 'SS':
      return len >= 2 ? buf.readInt16LE(off) : undefined;
    case 'UL':
      return len >= 4 ? buf.readUInt32LE(off) : undefined;
    case 'DS':
    case 'IS': {
      const s = latin1.decode(buf.subarray(off, off + len)).replace(/\0/g, '').trim();
      if (!s) return undefined;
      const nums = s.split('\\').map(Number);
      return nums.length === 1 ? nums[0] : nums;
    }
    default:
      return latin1.decode(buf.subarray(off, off + len)).replace(/\0/g, '').trim();
  }
}

export class DicomParseError extends Error {}

/**
 * Parse a DICOM buffer (possibly truncated to the header).
 * @param {Buffer} buf
 * @returns {{ transferSyntax: string, tags: Record<string, any>, pixelData?: {offset:number,length:number,encapsulated:boolean}, truncated: boolean }}
 */
export function parseDicom(buf) {
  let pos = 0;
  if (buf.length >= 132 && buf.toString('latin1', 128, 132) === 'DICM') pos = 132;
  else if (!(buf.length >= 8 && buf.readUInt16LE(0) === 0x0008)) {
    throw new DicomParseError('Not a DICOM file');
  }

  const out = { transferSyntax: TS_IMPLICIT_LE, tags: {}, pixelData: undefined, truncated: false };

  // File meta group (0002) is always explicit VR little endian.
  if (pos === 132) {
    while (pos + 8 <= buf.length && buf.readUInt16LE(pos) === 0x0002) {
      const el = readElementHeader(buf, pos, true);
      if (!el) break;
      if (el.tag === 0x00020010) out.transferSyntax = decodeValue(buf, el.valueOffset, el.length, 'UI');
      pos = el.valueOffset + el.length;
    }
  }

  const ts = out.transferSyntax;
  if (ts === TS_EXPLICIT_BE) throw new DicomParseError('Big endian transfer syntax not supported');
  if (ts === TS_DEFLATED_LE) throw new DicomParseError('Deflated transfer syntax not supported');
  const explicit = ts !== TS_IMPLICIT_LE;

  while (pos < buf.length) {
    if (pos + 8 > buf.length) { out.truncated = true; break; }
    const el = readElementHeader(buf, pos, explicit);
    if (!el) { out.truncated = true; break; }

    if (el.tag === PIXEL_DATA) {
      const encapsulated = el.length === UNDEFINED;
      out.pixelData = {
        offset: el.valueOffset,
        length: encapsulated ? buf.length - el.valueOffset : el.length,
        encapsulated,
      };
      if (!encapsulated && el.valueOffset + el.length > buf.length) out.truncated = true;
      break;
    }

    if (el.vr === 'SQ' || el.length === UNDEFINED) {
      const end = skipUndefinedOrSequence(buf, el, explicit);
      if (end < 0) { out.truncated = true; break; }
      pos = end;
      continue;
    }

    if (el.valueOffset + el.length > buf.length) { out.truncated = true; break; }

    const known = TAGS[el.tag];
    if (known) out.tags[known[0]] = decodeValue(buf, el.valueOffset, el.length, explicit ? el.vr : known[1]);
    pos = el.valueOffset + el.length;
  }
  return out;
}

function readElementHeader(buf, pos, explicit) {
  if (pos + 8 > buf.length) return null;
  const group = buf.readUInt16LE(pos);
  const element = buf.readUInt16LE(pos + 2);
  const tag = ((group << 16) | element) >>> 0;
  // Item / delimiter tags never carry a VR.
  if (group === 0xfffe) {
    return { tag, vr: '', length: buf.readUInt32LE(pos + 4), valueOffset: pos + 8 };
  }
  if (!explicit) {
    const known = TAGS[tag];
    return { tag, vr: known ? known[1] : 'UN?', length: buf.readUInt32LE(pos + 4), valueOffset: pos + 8 };
  }
  const vr = buf.toString('latin1', pos + 4, pos + 6);
  if (LONG_VRS.has(vr)) {
    if (pos + 12 > buf.length) return null;
    return { tag, vr, length: buf.readUInt32LE(pos + 8), valueOffset: pos + 12 };
  }
  return { tag, vr, length: buf.readUInt16LE(pos + 6), valueOffset: pos + 8 };
}

// Returns the offset just past a sequence (or undefined-length element), or -1 if truncated.
function skipUndefinedOrSequence(buf, el, explicit) {
  if (el.length !== UNDEFINED) {
    const end = el.valueOffset + el.length;
    return end <= buf.length ? end : -1;
  }
  let pos = el.valueOffset;
  while (pos + 8 <= buf.length) {
    const tag = ((buf.readUInt16LE(pos) << 16) | buf.readUInt16LE(pos + 2)) >>> 0;
    const len = buf.readUInt32LE(pos + 4);
    if (tag === SEQ_DELIM) return pos + 8;
    if (tag === ITEM) {
      if (len === UNDEFINED) {
        pos = skipItemDataset(buf, pos + 8, explicit);
        if (pos < 0) return -1;
      } else {
        pos += 8 + len;
      }
      continue;
    }
    // Undefined-length non-SQ element containing raw nested elements.
    const nested = readElementHeader(buf, pos, explicit);
    if (!nested) return -1;
    if (nested.vr === 'SQ' || nested.length === UNDEFINED) {
      pos = skipUndefinedOrSequence(buf, nested, explicit);
      if (pos < 0) return -1;
    } else {
      pos = nested.valueOffset + nested.length;
    }
  }
  return -1;
}

function skipItemDataset(buf, pos, explicit) {
  while (pos + 8 <= buf.length) {
    const tag = ((buf.readUInt16LE(pos) << 16) | buf.readUInt16LE(pos + 2)) >>> 0;
    if (tag === ITEM_DELIM) return pos + 8;
    const el = readElementHeader(buf, pos, explicit);
    if (!el) return -1;
    if (el.vr === 'SQ' || el.length === UNDEFINED) {
      pos = skipUndefinedOrSequence(buf, el, explicit);
      if (pos < 0) return -1;
    } else {
      pos = el.valueOffset + el.length;
    }
  }
  return -1;
}
