/* src/traps.js — the trap catalogue.
 *
 * Every entry is a lesson we learned by watching an agent's document toolbox for 48 hours:
 * a converter that exits 0 while writing nothing, a quality flag that changed nothing,
 * an extractor that read strings no pixel ever showed. The AUTHORITATIVE engine runs on the
 * `scorer` origin (the oracle is deliberately external); this copy exists so the canvas can
 * annotate individual step cards inline without a round trip. A test asserts the two copies
 * agree, so they cannot drift.
 *
 * ctx shape passed to `when`:
 *   { steps, ids, first, count, hasSequence, produces, consumes, notes }
 */

export const SEVERITY_WEIGHT = { high: 30, medium: 15, low: 8 };
export const PASS_SCORE = 100;

export const TRAPS = [
  {
    id: 'T01',
    severity: 'high',
    title: 'OCR after render on an image-only PDF',
    pattern: 'a rasterize step (pdf→png) feeds an OCR step',
    when: (c) => c.hasSequence('pdf-rasterize', 'ocr') || c.notes.inkParadox === true,
    lesson: 'Rendered text may be invisible text: a content-stream extractor reads strings the pixels never showed. Measure ink (getImageData) before trusting any text you did not paint, and treat ink==0 as "this page is blank", not "this page is empty".',
  },
  {
    id: 'T02',
    severity: 'medium',
    title: 'Extension-based dispatch inside a pipeline',
    pattern: 'a step that routes office documents by filename extension',
    when: (c) => c.steps.some((s) => s.extensionDispatch === true || EXTENSION_DISPATCH_IDS.includes(s.toolId)),
    lesson: 'Dispatch on extension while parsers dispatch on structure: a renamed file takes a different path than its bytes. Sniff the first bytes (magic) before choosing a branch — the safest branch is the one name-only routing skips.',
  },
  {
    id: 'T03',
    severity: 'medium',
    title: 'Round-trip through a converter that re-encodes',
    pattern: 'png→pdf→png (or any rename-based format claim)',
    when: (c) => c.ids.includes('rename-avif') ||
      (c.inputType === c.outputType && c.ids.length > 1 && c.ids.some((id) => RASTER_IDS.includes(id))),
    lesson: 'Converters may write a DIFFERENT format than you asked for (declared AVIF, actual PNG). Validate the magic bytes after every convert step, not just the file extension you handed it.',
  },
  {
    id: 'T04',
    severity: 'high',
    title: 'exit 0 with no output file',
    pattern: "a 'soffice-like' delegating conversion step, or a run that reported an empty output",
    when: (c) => c.ids.includes('docx-pdf-soffice') || c.notes.emptyOutput === true,
    lesson: 'Success code without an output file is the tool\'s bug, not yours. Assert the artifact exists and is non-empty before consuming it; "exit 0" is a claim about the process, not about the deliverable.',
  },
  {
    id: 'T05',
    severity: 'medium',
    title: 'Recalculate without validating',
    pattern: 'a spreadsheet recalc / numeric step',
    when: (c) => c.ids.includes('xlsx-recalc'),
    lesson: 'Numeric steps that return success even when errors_found is non-empty will launder #REF! and #VALUE! into your summary. Read the error list, not just the return code.',
  },
  {
    id: 'T06',
    severity: 'medium',
    title: 'Quality / compression parameter silently ignored',
    pattern: 'a quantize or compression step carrying a quality parameter',
    when: (c) => c.ids.includes('png-quality') || c.steps.some((s) => s.params && s.params.quality !== undefined),
    lesson: 'A parameter can be accepted, echoed back, and never used (q1..q99 produced byte-identical files). Diff the outputs at both extremes before you trust the knob you just turned.',
  },
  {
    id: 'T07',
    severity: 'low',
    title: 'Extraction order is not visual order',
    pattern: 'a PDF text-extraction step whose output is summarised or quoted',
    when: (c) => c.ids.includes('pdf-text') && (c.ids.includes('summarize') || c.ids.includes('md-html')),
    lesson: 'Reading order may differ from visual order — content streams are written in authoring order, which for tables and multi-column layouts is rarely top-to-bottom. Compare the sorted reading against the raw stream before summarising.',
  },
  {
    id: 'T08',
    severity: 'medium',
    title: 'Declared size vs decode stride budget',
    pattern: 'a resize step whose declared dimensions imply a huge decode buffer',
    when: (c) => c.steps.some((s) => {
      if (s.toolId !== 'png-resize' || !s.params) return false;
      const px = (Number(s.params.w) || 0) * (Number(s.params.h) || 0);
      return px * 4 > 64 * 1024 * 1024;
    }),
    lesson: 'Check file size against the stride budget before you decode: bytesIn was small while the RGBA buffer it expands into was enormous. Declared dimensions are a claim, not an allocation.',
  },
  {
    id: 'T09',
    severity: 'high',
    title: 'Silent empty result',
    pattern: 'table/structure extraction that reports success with zero rows',
    when: (c) => c.notes.emptyResult === true || c.ids.includes('png-tables') ||
      c.hasSequence('ocr', 'summarize') ||
      (c.ids.includes('ocr') && c.types.includes('csv-of-tables')),
    lesson: 'Zero tables plus no exception is a silent empty result, not a valid answer. Require an n>0 assertion on every extraction you are about to summarise — the failure mode is "the pipeline succeeded and produced nothing".',
  },
  {
    id: 'T10',
    severity: 'medium',
    title: 'Requested face may be substituted',
    pattern: 'a PDF export that declares a font the writer does not carry',
    when: (c) => c.steps.some((s) => s.params && s.params.font && String(s.params.font).toLowerCase().replace(/\s+/g, '') !== 'helvetica'),
    lesson: 'The font you asked for is not the font you get. Assert the embedded-font list after export; if the writer only ships one face, your Latin Modern is now Helvetica and your line breaks moved with it.',
  },
  {
    id: 'T11',
    severity: 'low',
    title: 'Zip-ratio accounting on chained intermediates',
    pattern: 'more than two office/zip intermediates in one chain',
    when: (c) => c.count((s) => ZIP_OUTPUTS.includes(s.out)) > 2,
    lesson: 'A 729KB container can mean 500MB inflated (our hero fixture declared 11,332,367× its compressed size). Guard intermediate byte budgets across the whole chain, not per step.',
  },
  {
    id: 'T12',
    severity: 'high',
    title: 'Unknown input type, name-only routing',
    pattern: 'input type is .doc / .rtf / unknown — no structural parser exists for it',
    when: (c) => !KNOWN_INPUT_TYPES.includes(c.inputType),
    lesson: 'Name-only routing skips the safest branch: magic sniffing. Inspect the first bytes for unknown inputs — if no parser in the chain can structurally read the input, every downstream "output" is a guess wearing your filename.',
  },
  {
    id: 'T13',
    severity: 'high',
    title: 'Declared output format vs actual bytes',
    pattern: 'a run reported an artifact whose magic bytes disagree with the declared type',
    when: (c) => c.notes.magicMismatch === true,
    lesson: 'Trust magic over extension: validate the artifact after every convert. A file named .png that starts with 52 49 46 46 is not a PNG, however confidently the tool described it.',
  },
  {
    id: 'T14',
    severity: 'medium',
    title: 'Extraction from a scan, asserted by absence',
    pattern: 'goal is a table/CSV out of a scanned image',
    when: (c) => !c.fired.includes('T09') && (c.ids.includes('ocr') || c.ids.includes('pdf-rasterize')) &&
      (c.outputType === 'csv' || c.outputType === 'csv-of-tables'),
    lesson: 'Scans rarely yield structure for free: expect n_tables==0 and assert it explicitly instead of letting an empty grid flow into a spreadsheet that looks finished.',
  },
  {
    id: 'T15',
    severity: 'low',
    title: 'Lossy step in a chain that claims a round trip',
    pattern: 'a quantize/lossy step inside a pipeline that returns to its input type',
    when: (c) => (c.ids.includes('png-quality') || c.ids.includes('ocr')) && c.inputType === c.outputType,
    lesson: 'A round trip that passes through a lossy step is not an identity. Compare bytes or a perceptual hash at the ends instead of assuming shape equality means content equality.',
  },
];

export const EXTENSION_DISPATCH_IDS = ['office-text', 'rename-avif'];
export const RASTER_IDS = ['pdf-rasterize', 'png-decode', 'png-encode', 'png-resize', 'png-quality', 'rename-avif'];
export const KNOWN_INPUT_TYPES = ['pdf', 'docx', 'xlsx', 'png', 'md', 'csv', 'txt', 'html', 'zip'];
export const ZIP_OUTPUTS = ['docx', 'xlsx', 'zip'];

export function scoreTraps(steps, notes = {}, opts = {}) {
  const ids = steps.map((s) => s.toolId);
  const types = steps.map((s) => s.out || s.outType || '');
  const fired = [];
  const ctx = {
    fired,
    steps,
    ids,
    types,
    inputType: opts.inputType || (steps[0] ? steps[0].in || steps[0].inType : undefined),
    outputType: opts.outputType || (steps.length ? steps[steps.length - 1].out || steps[steps.length - 1].outType : undefined),
    count: (fn) => steps.filter(fn).length,
    hasSequence: (a, b) => {
      const ia = ids.indexOf(a);
      return ia !== -1 && ids.indexOf(b, ia + 1) !== -1;
    },
    notes: notes || {},
  };
  const hits = [];
  let penalty = 0;
  for (const trap of TRAPS) {
    let isHit = false;
    try { isHit = !!trap.when(ctx); } catch (e) { isHit = false; }
    if (!isHit) continue;
    fired.push(trap.id);
    const weight = SEVERITY_WEIGHT[trap.severity] ?? 10;
    penalty += weight;
    hits.push({ trapId: trap.id, severity: trap.severity, weight, lesson: trap.lesson, title: trap.title });
  }
  const score = opts.mode === 'raw' ? PASS_SCORE - penalty : Math.max(0, PASS_SCORE - penalty);
  return {
    score,
    penalty,
    hits,
    stars: Math.max(0, Math.min(5, Math.round((score / PASS_SCORE) * 5 * 2) / 2)),
    engine: TRAP_ENGINE,
  };
}

export const TRAP_ENGINE = 'trap-engine/1.2 · distilled from a 48h sandbox audit of an agent document toolbox (paraphrased, no upstream prose)';
