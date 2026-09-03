/* src/bytes.js — byte helpers shared by every REAL transform in Recipe.
 * Everything in the engine moves as Uint8Array + a small `kind` tag, so a step
 * can honestly report bytesIn/bytesOut and hand an artifact link to the console. */

export function bytesFromB64(b64) {
  const clean = String(b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64FromBytes(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

export function latin1Encode(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[i] = c < 256 ? c : 63; // '?' for anything outside latin-1
  }
  return out;
}

export function latin1Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function textDecode(bytes) {
  try { return new TextDecoder('utf-8').decode(bytes); }
  catch (e) { return latin1Decode(bytes); }
}

export function textEncode(str) {
  return new TextEncoder().encode(str);
}

export function concatBytes(list) {
  let n = 0;
  for (const b of list) n += b.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const b of list) { out.set(b, o); o += b.length; }
  return out;
}

export function indexOfBytes(hay, needle, from = 0) {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* Magic sniff — the "inspect the first byte" branch that name-only routing skips. */
const SIGNATURES = [
  { type: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], name: 'PNG' },
  { type: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04], name: 'ZIP (stored/deflate container)' },
  { type: 'zip', bytes: [0x50, 0x4b, 0x50, 0x4b], name: 'ZIP (empty)' },
  { type: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46], name: 'PDF (%PDF)' },
  { type: 'jpeg', bytes: [0xff, 0xd8, 0xff], name: 'JPEG' },
  { type: 'gif', bytes: [0x47, 0x49, 0x46, 0x38], name: 'GIF' },
];

export function sniffMagic(bytes) {
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => bytes[i] === b)) {
      return { type: sig.type, magic: sig.name, confident: true };
    }
  }
  const head = bytes.subarray(0, Math.min(bytes.length, 512));
  const txt = latin1Decode(head);
  if (/^\s*<\?xml|^\s*<html|^\s*<!doctype/i.test(txt)) return { type: 'xml-or-html', magic: 'markup prolog', confident: true };
  // printable-ish? then it is text of some flavour (md/csv/txt are indistinguishable by bytes)
  let printable = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  const ratio = head.length ? printable / head.length : 0;
  if (ratio > 0.92) return { type: 'text', magic: 'printable bytes only', confident: false };
  return { type: 'unknown', magic: 'no known signature', confident: false };
}

export function pngDims(bytes) {
  if (bytes.length < 24) return null;
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export function jpegDims(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}
