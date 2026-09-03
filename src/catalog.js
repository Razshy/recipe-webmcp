/* src/catalog.js — the palette: every transform the studio knows about.
 * `engine` is deliberately blunt: REAL means "these bytes are processed in this tab,
 * right now, by the code in this folder"; SIMULATED means "the shape of the answer is
 * deterministic, the mechanism is the one that bit us upstream, and the UI says so". */

export const CATALOG = [
  /* ------------------------------ REAL ------------------------------ */
  {
    id: 'pdf-text', label: 'pdf → text', in: 'pdf', out: 'txt', mode: 'real',
    engine: 'hand-rolled content-stream interpreter: BT/ET, Tf, Td/TD/Tm/T*, TL, Tj/TJ/\'/" — plus FlateDecode via DecompressionStream. No PDF.js, no server.',
    detail: 'Reports both readings: raw (content-stream order) and visual (sorted by position). When they differ, the app says so instead of picking one.',
    traps: ['T07'],
  },
  {
    id: 'pdf-rasterize', label: 'pdf → png (paint)', in: 'pdf', out: 'png', mode: 'real',
    engine: 'same interpreter, painting text + rect operators onto a canvas at 1× scale, then encoding the canvas to PNG.',
    detail: 'Returns draw-op counts so you can measure ink instead of assuming a page has content.',
    traps: ['T01'],
  },
  {
    id: 'text-pdf', label: 'text → pdf', in: 'txt', out: 'pdf', mode: 'real',
    engine: 'emits a minimal single-font PDF (Helvetica / WinAnsiEncoding) with Tj operators, xref table and %%EOF.',
    detail: 'Round-trips through pdf → text: the sentinel you put in comes back out. Only Helvetica exists, which is exactly what T10 is about.',
    traps: ['T10'],
  },
  {
    id: 'md-html', label: 'markdown → html', in: 'md', out: 'html', mode: 'real',
    engine: 'small hand-written converter: headings, bold, italic, inline + fenced code, links, ul/ol, pipe tables, paragraphs.',
    traps: ['T07'],
  },
  {
    id: 'html-md', label: 'html → markdown', in: 'html', out: 'md', mode: 'real',
    engine: 'block-level pass over h1-6/p/ul/ol/blockquote/table/pre with inline backpass; unknown tags become text, never dropped.',
  },
  {
    id: 'html-text', label: 'html → text', in: 'html', out: 'txt', mode: 'real',
    engine: 'script/style removal, tag strip, block boundaries to newlines, entity decode.',
  },
  {
    id: 'md-pdf', label: 'markdown → pdf', in: 'md', out: 'pdf', mode: 'real',
    engine: 'chain: markdown → html (own converter) → text → minimal PDF. Markdown structure becomes plain lines.',
    traps: ['T10'],
  },
  {
    id: 'text-md', label: 'text → markdown', in: 'txt', out: 'md', mode: 'real',
    engine: 'paragraph/heading heuristics + markdown-significant character escaping.',
  },
  {
    id: 'docx-text', label: 'docx → text (via zip)', in: 'docx', out: 'txt', mode: 'real',
    engine: 'a .docx is a zip: reads the central directory, inflates word/document.xml, walks <w:t> runs, decodes entities, keeps table cells as tabs.',
    detail: 'This is the least simulated thing in the app — the fixture is a real zip and the parser is ours.',
    traps: ['T02', 'T11'],
  },
  {
    id: 'text-docx', label: 'text → docx (pack)', in: 'txt', out: 'docx', mode: 'real',
    engine: 'writes [Content_Types].xml, _rels/.rels and word/document.xml into a STORE-method zip. Readable by `unzip`.',
    traps: ['T11'],
  },
  {
    id: 'xlsx-csv', label: 'xlsx → csv (sheet1)', in: 'xlsx', out: 'csv', mode: 'real',
    engine: 'zip reader again: xl/worksheets/sheet1.xml + xl/sharedStrings.xml, with t="s" / t="inlineStr" / t="str" / t="e" cell handling and column-letter addressing.',
    traps: ['T05', 'T11'],
  },
  {
    id: 'csv-xlsx', label: 'csv → xlsx (pack)', in: 'csv', out: 'xlsx', mode: 'real',
    engine: 'RFC4180 parse, numeric inference, inline-string cells, five required xlsx parts, STORE-method zip.',
    traps: ['T11'],
  },
  {
    id: 'csv-md', label: 'csv → markdown table', in: 'csv', out: 'md', mode: 'real',
    engine: 'RFC4180 parse → GFM pipe table (pipes escaped, newlines flattened).',
  },
  {
    id: 'png-decode', label: 'png → RGBA pixels', in: 'png', out: 'rgba', mode: 'real',
    engine: 'createImageBitmap → canvas → getImageData. Reports stride bytes = w×h×4 so you can see the allocation the file size hides.',
    traps: ['T08'],
  },
  {
    id: 'png-encode', label: 'RGBA → png', in: 'rgba', out: 'png', mode: 'real',
    engine: 'putImageData → canvas.toDataURL("image/png"). Magic bytes verified after encode.',
    traps: ['T03'],
  },
  {
    id: 'png-resize', label: 'png → png (resize)', in: 'png', out: 'png', mode: 'real',
    engine: 'canvas drawImage with imageSmoothingQuality=high. Params: w, h.',
    params: { w: 'number', h: 'number' },
    traps: ['T08'],
  },
  {
    id: 'png-quality', label: 'png → png (quality q)', in: 'png', out: 'png', mode: 'real',
    engine: 're-encode through canvas with an explicit quality argument — and then measure whether the encoder honoured it.',
    detail: 'Measured truth: for PNG the quality argument is IGNORED. q1 and q99 come back byte-identical, so this step reports both outputs\' byte length rather than claiming a saving.',
    params: { quality: 'number' },
    traps: ['T06'],
  },
  {
    id: 'zip-pack', label: 'files → zip (store)', in: 'files', out: 'zip', mode: 'real',
    engine: 'writes local headers, central directory and EOCD with CRC-32. Method 0 (stored): declared size is the truth.',
    traps: ['T11'],
  },
  {
    id: 'zip-unpack', label: 'zip → files', in: 'zip', out: 'files', mode: 'real',
    engine: 'EOCD walk + central directory; STORED copied, DEFLATE inflated via DecompressionStream.',
    traps: ['T11'],
  },

  /* --------------------------- SIMULATED ---------------------------- */
  {
    id: 'ocr', label: 'png → text (OCR)', in: 'png', out: 'txt', mode: 'simulated',
    engine: 'simulated engine: deterministic pseudo-words derived from a hash of the image bytes, plus a confidence field that is always low.',
    detail: 'No OCR model ships in the browser bundle. The output is stable across runs so pipelines are testable, but the words are not real.',
    traps: ['T01', 'T09'],
  },
  {
    id: 'docx-pdf-soffice', label: 'docx → pdf (soffice-like)', in: 'docx', out: 'pdf', mode: 'simulated',
    engine: 'simulated delegating converter: models the exit-0-empty-output class we hit upstream — the process reports success, and sometimes no file is written.',
    traps: ['T04'],
  },
  {
    id: 'xlsx-recalc', label: 'xlsx → xlsx (recalc)', in: 'xlsx', out: 'xlsx', mode: 'simulated',
    engine: 'simulated numeric pass: returns success even when its own error list is non-empty (recalc-without-validate).',
    traps: ['T05'],
  },
  {
    id: 'office-text', label: 'doc/rtf → text (legacy)', in: 'doc', out: 'txt', mode: 'simulated',
    engine: 'simulated legacy handler that dispatches on FILE EXTENSION, not on bytes — the class of bug where a renamed file takes a different path than its content.',
    traps: ['T02', 'T12'],
  },
  {
    id: 'rename-avif', label: 'png → "avif" (renamed)', in: 'png', out: 'png', mode: 'simulated',
    engine: 'simulated format laundering: declares AVIF, writes PNG bytes. Magic bytes disagree with the claim 100% of the time.',
    traps: ['T03', 'T13'],
  },
  {
    id: 'summarize', label: 'text → summary', in: 'txt', out: 'txt', mode: 'simulated',
    engine: 'simulated extractive summariser: scores sentences by term frequency and keeps the top few. Deterministic, no model.',
    traps: ['T07', 'T09'],
  },
  {
    id: 'png-tables', label: 'png → csv-of-tables (scan)', in: 'png', out: 'csv-of-tables', mode: 'simulated',
    engine: 'simulated table detector for scans; returns an empty grid and no exception, which is precisely how a silent failure reaches a spreadsheet.',
    traps: ['T09', 'T14'],
  },
];

export const BY_ID = Object.fromEntries(CATALOG.map((t) => [t.id, t]));
export const GOALS = [
  { id: 'text', label: 'plain text', type: 'txt' },
  { id: 'csv', label: 'csv', type: 'csv' },
  { id: 'csv-of-tables', label: 'csv of the tables', type: 'csv-of-tables' },
  { id: 'pdf', label: 'pdf', type: 'pdf' },
  { id: 'png', label: 'png (rendered)', type: 'png' },
  { id: 'md', label: 'markdown', type: 'md' },
  { id: 'html', label: 'html', type: 'html' },
  { id: 'xlsx', label: 'spreadsheet', type: 'xlsx' },
];
/* Input choices for the human: each names the fixture it should run on, so the mislabeled scan
   really does select the PNG-bytes-named-.pdf fixture and not the honest PDF. */
export const INPUTS = [
  { id: 'pdf', label: '.pdf', type: 'pdf', fixture: 'pdf-doc' },
  { id: 'docx', label: '.docx', type: 'docx', fixture: 'docx-memo' },
  { id: 'xlsx', label: '.xlsx', type: 'xlsx', fixture: 'xlsx-sales' },
  { id: 'png', label: '.png', type: 'png', fixture: 'png-scan' },
  { id: 'md', label: '.md', type: 'md', fixture: 'md-notes' },
  { id: 'html', label: '.html', type: 'html', fixture: 'html-notes' },
  { id: 'csv', label: '.csv', type: 'csv', fixture: 'csv-sales' },
  { id: 'txt', label: '.txt', type: 'txt', fixture: 'txt-plain' },
  { id: 'zip', label: '.zip', type: 'zip', fixture: 'zip-packed' },
  { id: 'files', label: 'loose files', type: 'files', fixture: 'zip-parts' },
  { id: 'doc', label: '.doc (legacy)', type: 'doc', fixture: 'doc-legacy' },
  { id: 'scan', label: 'scan (unknown to the catalogue)', type: 'scan', fixture: 'png-scan' },
  { id: 'scan-mislabeled', label: 'scan named .pdf (bytes are PNG)', type: 'pdf', fixture: 'png-bytes-named-pdf' },
];
