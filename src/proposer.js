/* src/proposer.js — the scripted pipeline proposer.
 *
 * It is NOT a model: it is the pattern we watched an agent use, written down. It optimises
 * for "the chain looks plausible and finishes", which is exactly why it under-rates its own
 * pipelines. It self-scores with a confidence heuristic; the scorer origin disagrees, and the
 * UI prints the gap. That gap is the product. */

const SCRIPT = [
  {
    match: /table|csv|spreadsheet|numeric/i,
    from: 'xlsx',
    to: 'csv',
    steps: ['xlsx-csv'],
    claim: 98,
    rationale: 'Spreadsheets have structure; read sheet1 and hand back a grid. No rendering, no guessing.',
  },
  {
    match: /markdown|notes|readme|doc\b/i,
    from: 'docx',
    to: 'md',
    steps: ['docx-text', 'text-md'],
    claim: 92,
    rationale: 'Pull the runs out of the package, then re-impose heading structure. Both steps are structural, not visual.',
  },
  {
    match: /scan|image|photo|png|picture/i,
    from: 'scan',
    to: 'txt',
    steps: ['pdf-rasterize', 'ocr', 'summarize'],
    claim: 95,
    rationale: 'Paint the page, OCR the pixels, summarise the words. This is the chain that looked fine in the demo and produced nothing in production.',
  },
  {
    match: /archive|zip|bundle|unpack/i,
    from: 'zip',
    to: 'files',
    steps: ['zip-unpack'],
    claim: 99,
    rationale: 'One structural step. Nothing to lose.',
  },
  {
    match: /pdf|document|report|summary|text/i,
    from: 'pdf',
    to: 'txt',
    steps: ['pdf-text', 'summarize'],
    claim: 100,
    rationale: 'Extract the strings the content stream already contains, then compress them. Cheap and it always finishes.',
  },
];

export const PROPOSE_GOALS = [
  'turn a pdf into a summary',
  'get the tables out of a spreadsheet as csv',
  'summarize the scanned pdf',
  'convert docx into markdown notes',
  'unpack this archive',
];

export function propose(goal, inputType, outputType) {
  const g = String(goal || '');
  let hit = SCRIPT.find((s) => s.match.test(g));
  if (!hit) {
    hit = SCRIPT.reduce((best, s) => {
      const scoreScore = (s.from === inputType ? 2 : 0) + (s.to === outputType ? 3 : 0);
      const bestScore = (best.from === inputType ? 2 : 0) + (best.to === outputType ? 3 : 0);
      return scoreScore > bestScore ? s : best;
    }, SCRIPT[SCRIPT.length - 1]);
  }
  return {
    rationale: hit.rationale,
    selfScore: hit.claim,
    selfNotes: 'self-score is a confidence heuristic: structural steps score high, model-y steps score low. It never consults the trap engine — that is the point.',
    inputType: inputType || hit.from,
    outputType: outputType || hit.to,
    steps: hit.steps.map((toolId) => ({ toolId })),
  };
}

/* Chains the studio can execute end-to-end for a given (input → goal) pair. */
const CHAIN = {
  'txt>pdf': ['text-pdf'],
  'txt>md': ['text-md'],
  'txt>docx': ['text-docx'],
  'md>html': ['md-html'],
  'md>pdf': ['md-pdf'],
  'html>md': ['html-md'],
  'html>txt': ['html-text'],
  'pdf>txt': ['pdf-text'],
  'pdf>png': ['pdf-rasterize'],
  'docx>txt': ['docx-text'],
  'docx>md': ['docx-text', 'text-md'],
  'docx>pdf': ['docx-text', 'text-pdf'],
  'xlsx>csv': ['xlsx-csv'],
  'csv>xlsx': ['csv-xlsx'],
  'csv>md': ['csv-md'],
  'png>txt': ['ocr'],
  'png>rgba': ['png-decode'],
  'png>pdf': ['ocr', 'text-pdf'],
  'zip>files': ['zip-unpack'],
  'files>zip': ['zip-pack'],
};

export function planChain(from, to) {
  if (from === to) return [];
  const direct = CHAIN[from + '>' + to];
  if (direct) return direct.map((toolId) => ({ toolId }));
  const intermediates = Object.keys(CHAIN).filter((k) => k.startsWith(from + '>'));
  for (const k of intermediates) {
    const mid = k.split('>')[1];
    const rest = CHAIN[mid + '>' + to];
    if (rest) return [...CHAIN[k], ...rest].map((toolId) => ({ toolId }));
  }
  return null;
}
