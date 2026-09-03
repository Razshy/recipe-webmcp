/* src/pdf.js — hand-rolled PDF, both directions, no library.
 *  - writePdf(): emits a real minimal single-font PDF (Helvetica/WinAnsiEncoding, `Tj` ops)
 *    which then round-trips through extractPdfText(). That round-trip is the point: it is
 *    the one place in a document pipeline where you can prove the pipeline is not lying.
 *  - extractPdfText(): content-stream interpreter for `BT/ET`, `Tf Td TD Tm T* TL TJ Tj '` `"`.
 *  - renderPdf(): the same interpreter, but painting text + rects to a canvas, so
 *    "ink" can be measured instead of assumed.
 * Streams are read raw, and FlateDecode streams are inflated via DecompressionStream. */

import { concatBytes, latin1Decode, latin1Encode } from './bytes.js';
import { inflateRawBytes } from './inflate.js';

/* ---------------- escaping ---------------- */

const WINANSI = {
  '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84, '\u2026': 0x85,
  '\u2020': 0x86, '\u2021': 0x87, '\u02c6': 0x88, '\u2030': 0x89, '\u0160': 0x8a,
  '\u2039': 0x8b, '\u0152': 0x8c, '\u017d': 0x8e, '\u2018': 0x91, '\u2019': 0x92,
  '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02dc': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203a': 0x9b, '\u0153': 0x9c,
  '\u017e': 0x9e, '\u0178': 0x9f,
};

function toWinAnsi(str) {
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 256 && cp >= 32) out += ch;
    else if (cp === 9) out += '\t';
    else if (WINANSI[cp]) out += String.fromCharCode(WINANSI[cp]);
    else if (cp >= 0x2000 && cp <= 0x206f) out += '-';
    else out += '?';
  }
  return out;
}

function pdfString(str) {
  const s = toWinAnsi(str);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x28) out += '\\(';
    else if (c === 0x29) out += '\\)';
    else if (c === 0x5c) out += '\\\\';
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += s[i];
  }
  return '(' + out + ')';
}

/* ---------------- writer ---------------- */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const LEADING = 15;
const FONT_SIZE = 10.5;
const MAX_CHARS_PER_LINE = 92;

export function wrapText(text, width = MAX_CHARS_PER_LINE) {
  const out = [];
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (raw.length <= width) { out.push(raw); continue; }
    let line = '';
    for (const word of raw.split(' ')) {
      if ((line + ' ' + word).trim().length > width) { if (line) out.push(line); line = word; }
      else line = (line ? line + ' ' : '') + word;
    }
    out.push(line);
  }
  return out;
}

/**
 * opts.rects: [{x,y,w,h}] in PDF user space (origin bottom-left, points) — used by the
 * render/ink tests so a page can have measurable ink as well as extractable strings.
 */
export function writePdf(text, opts = {}) {
  const lines = wrapText(opts.header ? opts.header + '\n' + text : text);
  const linesPerPage = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
  const pages = [];
  for (let i = 0; i < lines.length || pages.length === 0; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  const objects = [];
  const pageObjNums = pages.map((_, i) => 4 + i * 2);
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids ${pageObjNums.map((n) => `${n} 0 R`).join(' ')}
     /Count ${pages.length} >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  pages.forEach((pageLines, idx) => {
    let cs = `BT\n/F1 ${FONT_SIZE} Tf\n${LEADING} TL\n${MARGIN} ${PAGE_H - MARGIN} Td\n`;
    pageLines.forEach((line, li) => {
      cs += `${pdfString(line)} Tj\n`;
      if (li !== pageLines.length - 1) cs += 'T*\n';
    });
    cs += 'ET\n';
    for (const r of (idx === 0 && opts.rects) || []) {
      cs += `${r.r ?? 0.1} ${r.g ?? 0.1} ${r.b ?? 0.2} rg\n${r.x} ${r.y} ${r.w} ${r.h} re f\n`;
    }
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + idx * 2} 0 R >>`);
    const body = latin1Encode(cs);
    objects.push({ dict: `<< /Length ${body.length} >>`, stream: body });
  });

  const parts = [];
  let pos = 0;
  const offsets = [];
  const push = (bytes) => { parts.push(bytes); pos += bytes.length; };
  push(latin1Encode('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'));
  objects.forEach((obj, i) => {
    offsets.push(pos);
    let head = `${i + 1} 0 obj\n`;
    if (typeof obj === 'string') {
      head += obj + '\nendobj\n';
      push(latin1Encode(head));
    } else {
      head += obj.dict + '\nstream\n';
      const tail = latin1Encode('\nendstream\nendobj\n');
      push(concatBytes([latin1Encode(head), obj.stream, tail]));
    }
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return concatBytes([...parts, latin1Encode(xref)]);
}

/* ---------------- content-stream tokenizer ---------------- */

function unescapePdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (n === '\n') continue;
    else out += n;
  }
  return out;
}

function winAnsiToUnicode(byteStr) {
  let out = '';
  for (let i = 0; i < byteStr.length; i++) {
    const c = byteStr.charCodeAt(i) & 0xff;
    if (c >= 0x80 && WINANSI_INV[c]) out += WINANSI_INV[c];
    else if (c < 32 && c !== 9 && c !== 10) out += ' ';
    else out += String.fromCharCode(c);
  }
  return out;
}

const WINANSI_INV = (() => {
  const m = {};
  for (const [ch, code] of Object.entries(WINANSI)) m[code] = ch;
  return m;
})();

async function tokenize(content) {
  const toks = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0') { i++; continue; }
    if (c === '%') { while (i < n && content[i] !== '\n') i++; continue; }
    if (c === '(') {
      let depth = 1; let j = i + 1; let buf = '';
      while (j < n && depth > 0) {
        const ch = content[j];
        if (ch === '\\') { buf += ch + (content[j + 1] ?? ''); j += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) break; }
        buf += ch; j++;
      }
      toks.push({ type: 'string', value: winAnsiToUnicode(unescapePdfString(buf)) });
      i = j + 1; continue;
    }
    if (c === '<') {
      if (content[i + 1] === '<') { toks.push({ type: 'dict' }); i += 2; continue; }
      const end = content.indexOf('>', i);
      const hex = content.slice(i + 1, end < 0 ? n : end).replace(/[^0-9a-fA-F]/g, '');
      let buf = '';
      for (let k = 0; k + 1 < hex.length; k += 2) buf += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
      toks.push({ type: 'string', value: winAnsiToUnicode(buf) });
      i = end < 0 ? n : end + 1; continue;
    }
    if (c === '>') { if (content[i + 1] === '>') { toks.push({ type: 'dict' }); i += 2; } else i++; continue; }
    if (c === '[') { toks.push({ type: 'open' }); i++; continue; }
    if (c === ']') { toks.push({ type: 'close' }); i++; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !/[\s/<>\[\]()%]/.test(content[j])) j++;
      toks.push({ type: 'name', value: content.slice(i + 1, j) });
      i = j; continue;
    }
    let j = i;
    while (j < n && !/[\s/<>\[\]()%]/.test(content[j])) j++;
    const word = content.slice(i, j);
    const num = Number(word);
    toks.push(Number.isFinite(num) && word !== '' ? { type: 'num', value: num } : { type: 'op', value: word });
    i = j;
  }
  return toks;
}

async function* streams(pdf) {
  const text = latin1Decode(pdf);
  let from = 0;
  for (;;) {
    const s = text.indexOf('stream', from);
    if (s === -1) return;
    let start = s + 6;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    const e = text.indexOf('endstream', start);
    if (e === -1) return;
    const dictStart = text.lastIndexOf('<<', s);
    const dict = dictStart !== -1 ? text.slice(dictStart, s) : '';
    let body = pdf.subarray(start, e);
    if (body.length && body[body.length - 1] === 0x0a) body = body.subarray(0, body.length - 1);
    if (/FlateDecode/.test(dict)) {
      try { body = await inflateRawBytes(body); } catch (err) { /* leave raw */ }
    }
    yield { raw: latin1Decode(body), dict };
    from = e + 9;
  }
}

/* ---------------- text extraction ---------------- */

/** -> {pages:[{placed:[{text,x,y}], raw}], text, rawText, stringCount, pageCount} */
export async function extractPdfText(pdfBytes) {
  const pages = [];
  let stringCount = 0;
  for await (const st of streams(pdfBytes)) {
    if (!/\bBT\b|\bTj\b|\bTJ\b/.test(st.raw)) continue;
    const toks = await tokenize(st.raw);
    const placed = [];
    const rawParts = [];
    let x = 0, y = 0, leading = 0, size = 12, inText = false;
    let pending = [];
    const flush = (dy) => {
      if (!pending.length) return;
      const text = pending.join('');
      pending = [];
      if (text) { placed.push({ text, x, y }); rawParts.push(text); }
      if (dy) y -= dy;
    };
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.type === 'op') {
        switch (t.value) {
          case 'BT': inText = true; x = 0; y = 0; break;
          case 'ET': flush(0); inText = false; break;
          case 'Td': x = num(toks, k - 2); y = num(toks, k - 1); break;
          case 'TD': x = num(toks, k - 2); y = num(toks, k - 1); leading = -num(toks, k - 1); break;
          case 'TL': leading = num(toks, k - 1); break;
          case 'Tf': {
            for (let m = k - 1; m >= 0 && toks[m].type !== 'op'; m--) if (toks[m].type === 'num') size = toks[m].value;
            break;
          }
          case 'Tm': {
            const args = [];
            for (let m = k - 1; m >= 0 && toks[m].type !== 'op'; m--) args.unshift(toks[m].value);
            if (args.length >= 6) { x = args[4]; y = args[5]; }
            break;
          }
          case 'T*': flush(leading || size * 1.2); break;
          case 'j': case 'Tj': {
            const s = strBefore(toks, k);
            if (s !== null) { stringCount++; pending.push(s); }
            break;
          }
          case "'": flush(leading || size * 1.2); { const s = strBefore(toks, k); if (s !== null) { stringCount++; pending.push(s); } } break;
          case '"': flush(leading || size * 1.2); { const s = strBefore(toks, k); if (s !== null) { stringCount++; pending.push(s); } } break;
          case 'TJ': {
            let parts = [];
            let open = -1;
            for (let m = k - 1; m >= 0; m--) if (toks[m].type === 'open') { open = m; break; }
            if (open === -1) break;
            for (let m = open + 1; m < k; m++) {
              const a = toks[m];
              if (a.type === 'string') parts.push(a.value);
              else if (a.type === 'num' && a.value <= -180) parts.push(' ');
            }
            const s = parts.join('');
            if (s) { stringCount++; pending.push(s); }
            break;
          }
          default: break;
        }
      }
    }
    flush(0);
    if (placed.length) pages.push({ placed, raw: rawParts.join('') });
  }
  // rawText = content-stream order (what the bytes say); text = visual order (what a human reads)
  const rawText = pages.map((p) => p.raw).join('\n');
  const visual = [];
  pages.forEach((p, pi) => {
    [...p.placed].sort((a, b) => (Math.round(b.y) - Math.round(a.y)) || (a.x - b.x))
      .forEach((it) => visual.push(it.text));
  });
  return {
    pages,
    pageCount: pages.length,
    stringCount,
    rawText,
    text: visual.join('\n'),
    orderMayDiffer: normalise(rawText) !== normalise(visual.join('\n')),
  };
}

function normalise(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function num(toks, i) { return i >= 0 && toks[i] && toks[i].type === 'num' ? toks[i].value : 0; }
function strBefore(toks, k) {
  for (let m = k - 1; m >= 0; m--) {
    const a = toks[m];
    if (a.type === 'op' || a.type === 'open' || a.type === 'close' || a.type === 'dict') return null;
    if (a.type === 'string') return a.value;
  }
  return null;
}

export async function pageCount(pdfBytes) {
  const text = latin1Decode(pdfBytes);
  const m = text.match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (m) return Number(m[1]);
  return (text.match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
}

/* ---------------- renderer (interpreter -> canvas) ---------------- */

/** Paints the PDF's own text + rect operators onto a canvas. Returns draw-op counts
 *  so callers can measure ink rather than trusting the presence of strings. */
export async function renderPdf(pdfBytes, canvas, scale = 1) {
  const total = await pageCount(pdfBytes);
  const w = Math.round(PAGE_W * scale);
  const h = Math.round(PAGE_H * scale);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const stats = { pages: total, drawnOps: 0, textOps: 0, textDrawn: 0, offPage: 0, rectOps: 0, inkPixels: 0, size: FONT_SIZE };
  const visible = (px, py) => {
    const cy = h - py * scale;
    return px * scale >= -2 && px * scale <= w + 2 && cy >= -2 && cy <= h + 2;
  };
  for await (const st of streams(pdfBytes)) {
    if (!/\bBT\b|\bre\b/.test(st.raw)) continue;
    const toks = await tokenize(st.raw);
    let x = 0, y = 0, leading = LEADING, size = FONT_SIZE, fill = [0, 0, 0];
    let pending = [];
    const flush = (dy) => {
      if (!pending.length) return;
      const s = pending.join(' '); pending = [];
      if (!s.trim()) { if (dy) y -= dy; return; }
      if (!visible(x, y)) {
        // the string exists in the content stream but lands outside the media box:
        // readable by an extractor, invisible to a human and to any pixel census
        stats.offPage++;
      } else {
        ctx.fillStyle = `rgb(${fill[0] * 255},${fill[1] * 255},${fill[2] * 255})`;
        ctx.font = `${size * scale}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(s, x * scale, h - y * scale);
        stats.textDrawn++; stats.drawnOps++;
      }
      if (dy) y -= dy;
    };
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.type !== 'op') continue;
      switch (t.value) {
        case 'BT': x = 0; y = 0; break;
        case 'ET': flush(0); break;
        case 'Td': x = num(toks, k - 2); y = num(toks, k - 1); break;
        case 'TD': x = num(toks, k - 2); y = num(toks, k - 1); break;
        case 'TL': leading = num(toks, k - 1); break;
        case 'Tf': { for (let m = k - 1; m >= 0 && toks[m].type !== 'op'; m--) if (toks[m].type === 'num') size = toks[m].value; break; }
        case 'Tm': { const a = []; for (let m = k - 1; m >= 0 && toks[m].type !== 'op'; m--) a.unshift(toks[m].value); if (a.length >= 6) { x = a[4]; y = a[5]; } break; }
        case 'T*': flush(leading); break;
        case 'j': case 'Tj': case "'": case '"': {
          const s = strBefore(toks, k);
          if (s !== null) pending.push(s);
          if (t.value === "'" || t.value === '"') flush(leading);
          else flush(0);
          break;
        }
        case 'rg': case 'g': {
          const a = [];
          for (let m = k - 1; m >= 0 && toks[m].type !== 'op'; m--) a.unshift(toks[m].value);
          fill = a.length >= 3 ? [a[0], a[1], a[2]] : [a[0] ?? 0, a[0] ?? 0, a[0] ?? 0];
          break;
        }
        case 're': {
          const a = [];
          for (let m = k - 1; m >= 0 && toks[m].type !== 'op'; m--) a.unshift(toks[m].value);
          if (a.length >= 4) {
            ctx.fillStyle = `rgb(${fill[0] * 255},${fill[1] * 255},${fill[2] * 255})`;
            ctx.fillRect(a[0] * scale, h - (a[1] + a[3]) * scale, a[2] * scale, a[3] * scale);
            stats.rectOps++; stats.drawnOps++;
          }
          break;
        }
        default: break;
      }
    }
    flush(0);
  }
  // the honest number: count pixels that differ from the white page, don't infer from op counts
  try {
    const img = ctx.getImageData(0, 0, w, h).data;
    let ink = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i] < 246 || img[i + 1] < 246 || img[i + 2] < 246) ink++;
    }
    stats.inkPixels = ink;
  } catch (e) {
    stats.inkPixels = -1;
  }
  return stats;
}

export const PDF_PAGE = { w: PAGE_W, h: PAGE_H };
