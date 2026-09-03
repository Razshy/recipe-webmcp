/* src/engine.js — pipeline validation + REAL execution. No scoring lives here: the studio has
 * no trap engine at all; it sends what it observed (and the artifact bytes) to the oracle origin.
 *
 * A document moving through a pipeline is `{ type, bytes?, text?, rgba?, files?, declaredType? }`.
 * Every step reports bytesIn/bytesOut and may attach `notes` — the runtime observations the
 * oracle labels as claimed (it re-measures what it can from the artifact bytes). A step that
 * cannot run honestly throws, and the notes it gathered before failing travel with the error. */

import { BY_ID } from './catalog.js';
import { bytesFromB64, b64FromBytes, pngDims, sniffMagic, textDecode, textEncode } from './bytes.js';
import { extractPdfText, renderPdf, writePdf } from './pdf.js';
import { mdToHtml, htmlToMd } from './markdown.js';
import { decodeEntities } from './entities.js';
import { docxToText, textToDocx, xlsxToCsv, csvToXlsx, csvToMarkdown } from './office.js';
import { readZip, writeZip } from './zip.js';

/* ---------------- validation ---------------- */

export function validatePipeline(pipeline) {
  const errors = [];
  const warnings = [];
  const steps = pipeline.steps || [];
  if (!steps.length) errors.push({ kind: 'empty', message: 'pipeline has no steps' });
  let current = pipeline.inputType;
  steps.forEach((s, i) => {
    const def = BY_ID[s.toolId];
    if (!def) {
      errors.push({ kind: 'unknown-tool', step: i, message: 'no transform with id "' + s.toolId + '"' });
      return;
    }
    if (current && def.in !== current) {
      const connector = findConnector(current, def.in);
      errors.push({
        kind: 'missing-connector',
        step: i,
        message: 'step ' + (i + 1) + ' "' + def.label + '" consumes ' + def.in + ' but the chain currently produces ' + current,
        fix: connector ? 'insert ' + connector + ' between step ' + i + ' and step ' + (i + 1) : 'no transform in the catalogue bridges ' + current + ' → ' + def.in,
      });
      current = def.out;
    } else {
      current = def.out;
    }
    if (def.mode === 'simulated') warnings.push({ kind: 'simulated', step: i, message: '"' + def.label + '" is simulated: ' + def.engine });
  });
  const produced = current;
  if (pipeline.outputType && produced && produced !== pipeline.outputType) {
    errors.push({
      kind: 'goal-mismatch',
      message: 'chain ends at ' + produced + ' but the goal is ' + pipeline.outputType,
      fix: connectorFix(produced, pipeline.outputType),
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    chain: [pipeline.inputType, ...steps.map((s) => (BY_ID[s.toolId] ? BY_ID[s.toolId].out : '?'))].filter(Boolean),
    endsAt: produced,
    goal: pipeline.outputType || null,
  };
}

function findConnector(from, to) {
  const hit = Object.values(BY_ID).find((d) => d.in === from && d.out === to);
  if (hit) return hit.id;
  const mid = Object.values(BY_ID).find((d) => d.in === from && Object.values(BY_ID).some((e) => e.in === d.out && e.out === to));
  return mid ? mid.id + ' → …' : null;
}
function connectorFix(from, to) {
  const c = findConnector(from, to);
  return c ? 'append ' + c : 'nothing in the catalogue reaches ' + to + ' from ' + from;
}

/* ---------------- step implementations ---------------- */

async function toBitmap(bytes) {
  const blob = new Blob([bytes], { type: 'image/png' });
  return await createImageBitmap(blob);
}

async function encodeCanvas(canvas, quality) {
  const url = quality === undefined
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/png', quality);
  return bytesFromB64(url.split(',')[1]);
}

async function canvasFromBytes(bytes, scale = 1, w, h) {
  const bmp = await toBitmap(bytes);
  const canvas = document.createElement('canvas');
  canvas.width = w || Math.max(1, Math.round(bmp.width * scale));
  canvas.height = h || Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  return canvas;
}

function hash32(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const OCR_WORDS = ['the', 'invoice', 'total', 'amount', 'due', 'page', 'table', 'quantity', 'unit', 'price', 'customer', 'order', 'net', 'gross', 'date', 'terms', 'subtotal', 'tax'];

/** Fails loudly when the bytes are not what the step was told they are — and keeps the note. */
function requireMagic(doc, wantType, notes, label) {
  const magic = sniffMagic(doc.bytes || new Uint8Array(0));
  if (magic.type === wantType) return magic;
  notes.magicMismatch = 'declared ' + (doc.declaredType || doc.type || wantType) + ', magic bytes say "' + magic.magic + '"';
  throw new Error(label + ' refused: not a ' + wantType.toUpperCase() + ' (magic says ' + magic.magic + ')');
}

async function executeStep(toolId, doc, params = {}, ctx = {}) {
  const def = BY_ID[toolId];
  if (!def) throw new Error('unknown transform: ' + toolId);
  const notes = {};
  const meta = {};
  const bytesIn = doc.bytes ? doc.bytes.length : (doc.text ? textEncode(doc.text).length : 0);
  const out = { type: def.out, notes, meta, bytesIn };
  try {
    await runStep(toolId, def, doc, params, ctx, out, notes, meta, bytesIn);
  } catch (err) {
    err.notes = notes; // partial observations survive the failure
    throw err;
  }
  return out;
}

async function runStep(toolId, def, doc, params, ctx, out, notes, meta, bytesIn) {
  switch (toolId) {
    case 'pdf-text': {
      requireMagic(doc, 'pdf', notes, 'pdf → text');
      const r = await extractPdfText(doc.bytes);
      out.text = r.text;
      meta.pages = r.pageCount;
      meta.strings = r.stringCount;
      meta.streamsFailed = r.streamsFailed;
      meta.orderMayDiffer = r.orderMayDiffer;
      if (r.streamsFailed) notes.decodeFailed = r.streamsFailed + ' content stream(s) would not inflate';
      if (r.stringCount === 0) notes.emptyResult = 'the extractor found no text strings (image-only or undecodable pages)';
      if (ctx.paint && ctx.paint.textDrawn === 0 && r.stringCount > 0) {
        notes.inkParadox = 'extractor read ' + r.stringCount + ' strings that painted ' + ctx.paint.textDrawn + ' glyphs';
      }
      if (r.orderMayDiffer) notes.orderDiffers = 'content-stream order differs from visual order';
      break;
    }
    case 'pdf-rasterize': {
      requireMagic(doc, 'pdf', notes, 'pdf → png');
      const canvas = document.createElement('canvas');
      const stats = await renderPdf(doc.bytes, canvas, 1);
      ctx.paint = stats;
      out.bytes = await encodeCanvas(canvas);
      ctx.rasterBytes = out.bytes;
      ctx.rasterDims = pngDims(out.bytes);
      meta.dims = ctx.rasterDims;
      meta.drawOps = stats.drawnOps;
      meta.textDrawn = stats.textDrawn;
      meta.textOffPage = stats.offPage;
      meta.rects = stats.rects;
      meta.inkPixels = stats.inkPixels;
      if (stats.inkPixels === 0) notes.emptyResult = 'ink census == 0: this page is blank, not merely empty';
      break;
    }
    case 'text-pdf': {
      const rects = [];
      const painted = ctx.paint && ctx.paint.rectOps ? ctx.paint.rectOps : 0;
      for (let i = 0; i < painted; i++) {
        rects.push({ x: 54 + i * 22, y: 120, w: 12, h: 12, r: 0.1, g: 0.1, b: 0.2 });
      }
      out.bytes = writePdf(doc.text || '', { rects });
      meta.embeddedFonts = ['Helvetica (Type1, not embedded)'];
      meta.pages = 1 + Math.max(0, Math.ceil((String(doc.text || '').split('\n').length - 46) / 46));
      ctx.embedList = meta.embeddedFonts;
      if (params.font && String(params.font).toLowerCase().replace(/\s+/g, '') !== 'helvetica') {
        meta.requestedFont = String(params.font);
        meta.substituted = true;
      }
      break;
    }
    case 'md-html': out.text = mdToHtml(doc.text || ''); break;
    case 'html-md': out.text = htmlToMd(doc.text || ''); break;
    case 'html-text': out.text = decodeEntities((doc.text || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()) + '\n'; break;
    case 'text-md': out.text = toMarkdown(doc.text || ''); break;
    case 'md-pdf': {
      const html = mdToHtml(doc.text || '');
      const plain = html.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      out.text = undefined;
      out.bytes = writePdf(plain);
      meta.embeddedFonts = ['Helvetica (Type1, not embedded)'];
      break;
    }
    case 'docx-text': {
      requireMagic(doc, 'zip', notes, 'docx → text');
      const r = await docxToText(doc.bytes);
      out.text = r.text;
      meta.entries = r.stats.entryCount;
      meta.paragraphs = r.stats.paragraphs;
      meta.runs = r.stats.runs;
      meta.tables = r.stats.tables;
      if (r.text.trim() === '') notes.emptyResult = 'the package opened but carried no text runs';
      break;
    }
    case 'text-docx': {
      const z = textToDocx(doc.text || '');
      out.bytes = z.bytes;
      meta.entries = z.entryCount;
      meta.declaredRatio = z.declaredRatio;
      break;
    }
    case 'xlsx-csv': {
      requireMagic(doc, 'zip', notes, 'xlsx → csv');
      const r = await xlsxToCsv(doc.bytes);
      out.text = r.csv;
      out.type = 'csv';
      Object.assign(meta, r.stats);
      if (r.stats.rows === 0) notes.emptyResult = 'the worksheet had no rows';
      if (r.stats.errorsFound > 0) notes.cellErrors = r.stats.errorsFound + ' cell(s) carry a spreadsheet error value';
      break;
    }
    case 'csv-xlsx': {
      const r = csvToXlsx(doc.text || '');
      out.bytes = r.bytes;
      meta.rows = r.rows;
      meta.declaredRatio = r.declaredRatio;
      break;
    }
    case 'csv-md': {
      const r = csvToMarkdown(doc.text || '');
      out.text = r.md;
      meta.rows = r.rows;
      meta.cols = r.cols;
      if (r.rows === 0) notes.emptyResult = 'no rows parsed from the csv';
      break;
    }
    case 'png-decode': {
      requireMagic(doc, 'png', notes, 'png → rgba');
      const canvas = await canvasFromBytes(doc.bytes);
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      out.rgba = { data: new Uint8Array(img.data.buffer), width: canvas.width, height: canvas.height };
      out.type = 'rgba';
      meta.dims = { width: canvas.width, height: canvas.height };
      meta.strideBytes = canvas.width * canvas.height * 4;
      meta.inflation = bytesIn ? meta.strideBytes / bytesIn : 0;
      if (meta.strideBytes > 64 * 1024 * 1024) notes.strideWarn = 'stride budget ' + meta.strideBytes + ' bytes from a ' + bytesIn + ' byte file';
      break;
    }
    case 'png-encode': {
      const canvas = document.createElement('canvas');
      canvas.width = doc.rgba.width; canvas.height = doc.rgba.height;
      const c2 = canvas.getContext('2d');
      c2.fillStyle = '#fff'; c2.fillRect(0, 0, canvas.width, canvas.height);
      c2.putImageData(new ImageData(new Uint8ClampedArray(doc.rgba.data.buffer), doc.rgba.width, doc.rgba.height), 0, 0);
      out.bytes = await encodeCanvas(canvas);
      meta.dims = pngDims(out.bytes);
      meta.magicOk = sniffMagic(out.bytes).type === 'png';
      if (!meta.magicOk) notes.magicMismatch = 'encoder produced non-PNG bytes';
      break;
    }
    case 'png-resize': {
      requireMagic(doc, 'png', notes, 'png → png (resize)');
      const w = Number(params.w) || 640;
      const h = Number(params.h) || 480;
      const canvas = await canvasFromBytes(doc.bytes, 1, w, h);
      out.bytes = await encodeCanvas(canvas);
      meta.dims = pngDims(out.bytes);
      meta.strideBytes = w * h * 4;
      break;
    }
    case 'png-quality': {
      requireMagic(doc, 'png', notes, 'png → png (quality)');
      const q = Number(params.quality);
      const canvas = await canvasFromBytes(doc.bytes);
      const withQ = await encodeCanvas(canvas, Number.isFinite(q) ? Math.min(1, Math.max(0, q / 100)) : 0.5);
      const plain = await encodeCanvas(canvas);
      out.bytes = withQ;
      meta.qualityRequested = Number.isFinite(q) ? q : null;
      meta.bytesWithQuality = withQ.length;
      meta.bytesWithoutQuality = plain.length;
      meta.qualityHonored = withQ.length !== plain.length;
      if (!meta.qualityHonored) notes.qualityIgnored = 'quality=' + (meta.qualityRequested ?? 'n/a') + ' produced byte-identical output (' + plain.length + 'B): the encoder ignored the parameter';
      break;
    }
    case 'zip-pack': {
      const files = doc.files && doc.files.length ? doc.files : [{ name: 'part-1.bin', data: doc.bytes || new Uint8Array(0) }];
      const z = writeZip(files);
      out.bytes = z.bytes;
      meta.entries = z.entryCount;
      meta.declaredRatio = z.declaredRatio;
      meta.method = 'store (0)';
      break;
    }
    case 'zip-unpack': {
      requireMagic(doc, 'zip', notes, 'zip → files');
      const entries = await readZip(doc.bytes);
      out.files = entries.map((e) => ({ name: e.name, bytes: e.data.length, data: e.data }));
      meta.entries = entries.length;
      meta.methodCounts = entries.reduce((a, e) => { a['method' + e.method] = (a['method' + e.method] || 0) + 1; return a; }, {});
      meta.compressedTotal = entries.reduce((a, e) => a + e.compSize, 0);
      meta.inflatedTotal = entries.reduce((a, e) => a + e.size, 0);
      meta.declaredRatio = meta.compressedTotal ? meta.inflatedTotal / meta.compressedTotal : 1;
      break;
    }

    /* -------- simulated engines (honest: they say so in `meta.mode`) -------- */
    case 'ocr': {
      const seed = hash32(doc.bytes || new Uint8Array(0));
      const n = 14;
      const words = [];
      for (let i = 0; i < n; i++) words.push(OCR_WORDS[(seed >>> (i % 8) + i * 3) % OCR_WORDS.length]);
      out.text = words.join(' ') + '\n';
      meta.confidence = 0.31;
      meta.words = n;
      meta.engine = 'simulated (deterministic pseudo-words from a byte hash)';
      if (ctx.paint && ctx.paint.textDrawn === 0) {
        notes.inkParadox = 'OCR ran on a page whose ink census was 0: whatever it "read" was never painted';
      }
      if (ctx.rasterBytes) meta.inputDims = ctx.rasterDims || pngDims(ctx.rasterBytes);
      break;
    }
    case 'docx-pdf-soffice': {
      const empty = params.empty === true || params.empty === 'true';
      out.bytes = empty ? new Uint8Array(0) : writePdf('(soffice-like delegation) ' + (ctx.delegateText || ''));
      meta.exitCode = 0;
      meta.artifactBytes = out.bytes.length;
      meta.engine = 'simulated delegating converter (exit-0-empty-output class)';
      if (empty) notes.emptyOutput = 'exit code 0 but the output file is ' + out.bytes.length + ' bytes: success without a deliverable';
      break;
    }
    case 'xlsx-recalc': {
      out.bytes = doc.bytes;
      meta.exitCode = 0;
      meta.errorsFound = ['Sheet1!C7: #REF!', 'Sheet1!D2: #VALUE!'];
      meta.engine = 'simulated numeric pass';
      notes.recalcWithoutValidate = 'reports success while errorsFound has ' + meta.errorsFound.length + ' entries';
      break;
    }
    case 'office-text': {
      out.text = 'simulated legacy text extract\n';
      meta.dispatchedOn = 'extension "' + (ctx.inputName || 'untitled.doc') + '" (no byte sniff)';
      meta.engine = 'simulated legacy handler';
      const magic = doc.bytes ? sniffMagic(doc.bytes) : null;
      if (magic && magic.type === 'zip') notes.extensionLie = 'bytes are a zip package; extension dispatch sent it down the .doc path instead';
      break;
    }
    case 'rename-avif': {
      out.bytes = doc.bytes;
      out.declaredType = 'avif';
      meta.declaredFormat = 'AVIF';
      meta.actualMagic = sniffMagic(doc.bytes || new Uint8Array(0)).magic;
      meta.engine = 'simulated format laundering';
      notes.magicMismatch = 'declared AVIF, magic bytes say "' + meta.actualMagic + '"';
      break;
    }
    case 'summarize': {
      const src = String(doc.text || '');
      const sentences = src.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 12);
      out.text = (sentences.slice(0, 2).join(' ') || src.slice(0, 160)) + '\n';
      meta.inputChars = src.length;
      meta.outputChars = out.text.length;
      meta.engine = 'simulated extractive summariser (term-frequency sentence scoring)';
      if (src.trim() === '') notes.emptyResult = 'summarised an empty input into an empty output';
      break;
    }
    case 'png-tables': {
      out.text = '';
      out.type = 'csv-of-tables';
      meta.tablesFound = 0;
      meta.rows = 0;
      meta.threw = false;
      meta.engine = 'simulated scan table detector';
      notes.emptyResult = 'n_tables == 0 and no exception raised: a silent empty result flowed to the next step';
      break;
    }
    default:
      throw new Error('no executor for ' + toolId);
  }
  finishStep(toolId, def, out, notes);
}

function finishStep(toolId, def, out, notes) {
  if (out.bytes) {
    out.bytesOut = out.bytes.length;
    const magic = sniffMagic(out.bytes);
    out.magic = magic.magic;
    out.magicType = magic.type;
    // the honest check: does the artifact's magic agree with the type we claim to have produced?
    const EXPECTED = { png: 'png', docx: 'zip', xlsx: 'zip', zip: 'zip', pdf: 'pdf' };
    const want = EXPECTED[out.type];
    if (want && magic.type !== want && toolId !== 'rename-avif') {
      notes.magicMismatch = notes.magicMismatch || 'expected ' + want.toUpperCase() + ' magic, got "' + magic.magic + '"';
    }
  } else if (out.text != null) {
    out.bytesOut = textEncode(out.text).length;
  } else if (out.rgba) {
    out.bytesOut = out.rgba.width * out.rgba.height * 4;
  } else if (out.files) {
    out.bytesOut = out.files.reduce((a, f) => a + (f.bytes || 0), 0);
  } else {
    out.bytesOut = 0;
  }
  out.type = out.type || def.out;
}

function toMarkdown(text) {
  const blocks = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((b) => {
    const lines = b.split('\n');
    if (lines.length === 1 && lines[0].length < 70 && /[A-Z]/.test(lines[0]) && !/[.!?,;:]$/.test(lines[0])) {
      return '## ' + lines[0].trim();
    }
    return lines.map((l) => l.trim()).join('\n');
  }).join('\n\n') + '\n';
}

/* ---------------- pipeline run ---------------- */

/** opts.onStep(event) streams progress; opts.signal (from execute's second argument) cancels between steps. */
export async function runPipeline(pipeline, fixture, opts = {}) {
  const onStep = opts.onStep || (() => {});
  const signal = opts.signal || null;
  const started = performance.now();
  const steps = pipeline.steps || [];
  let doc = docFromFixture(fixture, pipeline.inputType);
  const ctx = { inputName: fixture ? fixture.name : 'untitled', paint: null };
  const results = [];
  const notes = {};
  let aborted = false;

  for (let i = 0; i < steps.length; i++) {
    const spec = steps[i];
    const def = BY_ID[spec.toolId];
    const t0 = performance.now();
    if (!def) {
      results.push({ step: i + 1, toolId: spec.toolId, ok: false, error: 'unknown transform' });
      aborted = true;
      break;
    }
    if (signal && signal.aborted) {
      results.push({ step: i + 1, toolId: spec.toolId, ok: false, error: 'cancelled before this step ran' });
      aborted = true;
      break;
    }
    await onStep({ phase: 'start', step: i + 1, toolId: spec.toolId, label: def.label, mode: def.mode });
    try {
      const out = await executeStep(spec.toolId, doc, spec.params || {}, ctx);
      Object.entries(out.notes || {}).forEach(([k, v]) => { notes[k] = v; });
      doc = { type: out.type, bytes: out.bytes, text: out.text, rgba: out.rgba, files: out.files, declaredType: out.declaredType || out.type };
      const rec = {
        step: i + 1,
        toolId: spec.toolId,
        label: def.label,
        mode: def.mode,
        ok: true,
        inType: def.in,
        outType: out.type,
        bytesIn: out.bytesIn,
        bytesOut: out.bytesOut,
        magic: out.magic || null,
        magicType: out.magicType || null,
        ms: Math.round((performance.now() - t0) * 100) / 100,
        meta: out.meta || {},
        notes: out.notes || {},
      };
      results.push(rec);
      await onStep({ phase: 'end', ...rec, artifact: artifactFor(out, spec.toolId) });
    } catch (err) {
      aborted = true;
      Object.entries(err && err.notes ? err.notes : {}).forEach(([k, v]) => { notes[k] = v; });
      const rec = {
        step: i + 1, toolId: spec.toolId, label: def.label, mode: def.mode, ok: false,
        error: String(err && err.message ? err.message : err),
        ms: Math.round((performance.now() - t0) * 100) / 100,
        notes: err && err.notes ? err.notes : {},
      };
      results.push(rec);
      await onStep({ phase: 'error', ...rec });
      break;
    }
  }

  return {
    ok: !aborted && results.length === steps.length,
    aborted,
    pipelineId: pipeline.id || null,
    steps: results,
    notes,
    ms: Math.round(performance.now() - started),
    finalType: doc.type,
    artifact: summariseArtifact(doc, pipeline.outputType),
    artifactBytes: doc.bytes || null,
  };
}

/** Compact, agent-facing description of the document at the end of the chain (no payload). */
function summariseArtifact(doc, wantType) {
  const out = { type: doc.type, declaredType: doc.declaredType || doc.type, wantType: wantType || null, bytes: doc.bytes ? doc.bytes.length : null };
  if (doc.text != null) {
    out.preview = doc.text.slice(0, 240);
    out.chars = doc.text.length;
  }
  if (doc.bytes) {
    const magic = sniffMagic(doc.bytes);
    out.magic = magic.magic;
    out.magicType = magic.type;
    if (magic.type === 'png') out.dims = pngDims(doc.bytes);
    if (doc.bytes.length === 0) out.empty = true;
  }
  if (doc.rgba) out.dims = { width: doc.rgba.width, height: doc.rgba.height };
  if (doc.files) out.files = doc.files.map((f) => ({ name: f.name, bytes: f.bytes }));
  if (wantType && doc.type !== wantType) out.goalTypeMismatch = true;
  return out;
}

const TEXT_TYPES = ['txt', 'md', 'csv', 'html', 'csv-of-tables'];

function docFromFixture(fixture, wantType) {
  if (!fixture) throw new Error('no fixture supplied');
  if (fixture.kind === 'files') return { type: 'files', files: fixture.files, name: fixture.name };
  const bytes = fixture.bytes || null;
  if (!bytes && fixture.text == null) throw new Error('fixture has no bytes or text');
  const sniffed = bytes ? sniffMagic(bytes) : null;
  const declared = fixture.type || wantType;
  const doc = { type: declared || (sniffed && sniffed.type) || 'txt', bytes: bytes || textEncode(fixture.text), name: fixture.name, sniffed };
  // what the pipeline asserts it is feeding (name-only routing), which the oracle re-checks against the bytes
  doc.declaredType = wantType || doc.type;
  // text-ish inputs carry a decoded string as well as bytes, so a step never guesses at encoding
  if (TEXT_TYPES.includes(doc.type)) {
    doc.text = fixture.text != null ? fixture.text : textDecode(bytes);
  } else if (fixture.text != null) {
    doc.text = fixture.text;
  }
  return doc;
}

function artifactFor(out, toolId) {
  if (out.bytes && out.bytes.length && out.bytes.length < 400000) {
    if (out.magicType === 'png') return { kind: 'png', dataUrl: 'data:image/png;base64,' + b64FromBytes(out.bytes), bytes: out.bytes.length };
    return { kind: 'bytes', name: toolId + '-out', bytes: out.bytes.length };
  }
  if (out.text != null) return { kind: 'text', text: out.text.slice(0, 4000), bytes: out.bytesOut };
  if (out.rgba) return { kind: 'rgba', dims: { width: out.rgba.width, height: out.rgba.height } };
  return null;
}
