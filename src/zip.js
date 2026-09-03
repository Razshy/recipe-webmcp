/* src/zip.js — real ZIP reader/writer.
 * Reading handles both STORED and DEFLATE entries (deflate via DecompressionStream),
 * which is what lets docx/xlsx parsing be genuinely REAL rather than simulated:
 * a .docx is just a zip whose word/document.xml you can read.
 * Writing is STORE-only (legal, readable by `unzip`), with an honest `declaredRatio`
 * so the run console can show the zip-bloat accounting the trap catalogue warns about. */

import { concatBytes, crc32, indexOfBytes, latin1Decode, latin1Encode } from './bytes.js';
import { inflateRawBytes } from './inflate.js';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LF_SIG = 0x04034b50;

function u16(dv, p) { return dv.getUint16(p, true); }
function u32(dv, p) { return dv.getUint32(p, true); }

export function findEocd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const maxBack = Math.min(bytes.length, 22 + 65535);
  for (let i = bytes.length - 22; i >= bytes.length - maxBack && i >= 0; i--) {
    if (u32(dv, i) === EOCD_SIG) return { pos: i, count: u16(dv, i + 10), cdSize: u32(dv, i + 12), cdOff: u32(dv, i + 16) };
  }
  return null;
}

export function isZip(bytes) {
  return !!bytes && bytes.length > 4 && u32(new DataView(bytes.buffer, bytes.byteOffset, bytes.length), 0) === LF_SIG;
}

/** -> [{name, method, crc, compSize, size, data:Uint8Array}] */
export async function readZip(bytes) {
  const eocd = findEocd(bytes);
  if (!eocd) throw new Error('not a zip: no end-of-central-directory record');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const entries = [];
  let p = eocd.cdOff;
  for (let n = 0; n < eocd.count; n++) {
    if (u32(dv, p) !== CD_SIG) break;
    const method = u16(dv, p + 10);
    const crc = u32(dv, p + 16);
    const compSize = u32(dv, p + 20);
    const size = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const cmtLen = u16(dv, p + 32);
    const lho = u32(dv, p + 42);
    const name = latin1Decode(bytes.subarray(p + 46, p + 46 + nameLen));
    let data = new Uint8Array(0);
    if (indexOfBytes(bytes.subarray(lho, lho + 4), new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 0) === 0) {
      const lName = u16(dv, lho + 26), lExtra = u16(dv, lho + 28);
      const start = lho + 30 + lName + lExtra;
      const raw = bytes.subarray(start, start + compSize);
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRawBytes(raw);
    }
    entries.push({ name, method, crc, compSize, size, data });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

export async function zipEntry(entries, name) {
  const hit = entries.find((e) => e.name === name);
  return hit ? hit.data : null;
}

/** STORE-only writer. Returns {bytes, declaredRatio} where declaredRatio is
 *  uncompressed/compressed per entry (1.0 here, by construction — a stored zip
 *  never lies about its size, which is exactly the property T11 warns you to check). */
export function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = latin1Encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, LF_SIG, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    locals.push(lh, data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, CD_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centrals.push(ch);
    offset += lh.length + data.length;
  }
  const cd = concatBytes(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);
  const bytes = concatBytes([...locals, cd, eocd]);
  const declared = files.reduce((a, f) => a + f.data.length, 0);
  return { bytes, declaredRatio: bytes.length ? declared / bytes.length : 1, entryCount: files.length };
}
