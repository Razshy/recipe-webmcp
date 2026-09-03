/* src/inflate.js — raw-deflate (zip entries) and zlib (PDF FlateDecode) inflate via
 * DecompressionStream, with a tiny built-in fallback for browsers without the API. */

export async function inflateRawBytes(bytes) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return fallbackInflateRaw(bytes);
}

export async function inflateZlib(bytes) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return fallbackInflateRaw(bytes.subarray(2));
}

/* Minimal fixed+dynamic Huffman raw-deflate decoder (no LZ77 window bugs to win here:
 * it is only a fallback path for browsers without DecompressionStream). */
function fallbackInflateRaw(src) {
  let bitPos = 0;
  const out = [];
  let bfinal = 0;
  const bitsRead = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = src[bitPos >> 3] ?? 0;
      v |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return v;
  };
  function buildTree(lengths) {
    const max = Math.max(...lengths, 1);
    const blCount = new Array(max + 1).fill(0);
    for (const l of lengths) if (l) blCount[l]++;
    const nextCode = new Array(max + 1).fill(0);
    let code = 0;
    for (let b = 1; b <= max; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
    const map = {};
    for (let s = 0; s < lengths.length; s++) {
      const l = lengths[s];
      if (!l) continue;
      map[l + ':' + nextCode[l].toString(2).padStart(l, '0')] = s;
      nextCode[l]++;
    }
    return map;
  }
  const decodeSym = (map) => {
    let key = '';
    for (let l = 1; l <= 15; l++) {
      key += String(bitsRead(1));
      const hit = map[l + ':' + key];
      if (hit !== undefined) return hit;
    }
    throw new Error('bad deflate code');
  };
  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  do {
    bfinal = bitsRead(1);
    const type = bitsRead(2);
    if (type === 0) {
      bitPos = (bitPos + 7) & ~7;
      const p = bitPos >> 3;
      const len = src[p] | (src[p + 1] << 8);
      for (let i = 0; i < len; i++) out.push(src[p + 2 + i]);
      bitPos += 32 + len * 8;
      continue;
    }
    let litTree, distTree;
    if (type === 1) {
      const l = new Array(288);
      for (let i = 0; i < 144; i++) l[i] = 8;
      for (let i = 144; i < 256; i++) l[i] = 9;
      for (let i = 256; i < 280; i++) l[i] = 7;
      for (let i = 280; i < 288; i++) l[i] = 8;
      litTree = buildTree(l);
      distTree = buildTree(new Array(30).fill(5));
    } else if (type === 2) {
      const hlit = bitsRead(5) + 257, hdist = bitsRead(5) + 1, hclen = bitsRead(4) + 4;
      const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const hl = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) hl[ORDER[i]] = bitsRead(3);
      const hTree = buildTree(hl);
      const lens = [];
      while (lens.length < hlit + hdist) {
        const sym = decodeSym(hTree);
        if (sym < 16) lens.push(sym);
        else if (sym === 16) { let r = 3 + bitsRead(2); while (r-- > 0) lens.push(lens[lens.length - 1]); }
        else if (sym === 17) { let r = 3 + bitsRead(3); while (r-- > 0) lens.push(0); }
        else { let r = 11 + bitsRead(7); while (r-- > 0) lens.push(0); }
      }
      litTree = buildTree(lens.slice(0, hlit));
      distTree = buildTree(lens.slice(hlit, hlit + hdist));
    } else throw new Error('bad deflate block type');
    for (;;) {
      const sym = decodeSym(litTree);
      if (sym < 256) out.push(sym);
      else if (sym === 256) break;
      else {
        const idx = sym - 257;
        const len = LEN_BASE[idx] + bitsRead(LEN_EXTRA[idx]);
        const dsym = decodeSym(distTree);
        const dist = DIST_BASE[dsym] + bitsRead(DIST_EXTRA[dsym]);
        for (let i = 0; i < len; i++) out.push(out[out.length - dist]);
      }
    }
  } while (!bfinal);
  return Uint8Array.from(out);
}
