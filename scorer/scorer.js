/* scorer/scorer.js — the trap engine, living on its own origin.
 * The studio cannot import this file (different origin, and it does not try to);
 * it can only call these tools. That separation is the whole point of the app. */

import { TRAPS, SEVERITY_WEIGHT, scoreTraps, TRAP_ENGINE, PASS_SCORE } from './traps.js';

const mainOrigin = window.MC.origin('main');
const selfOrigin = window.MC.origin('scorer');
const ORACLE = 'scorer:' + selfOrigin;
let callCount = 0;

/* The caller describes its own chain; the engine only judges it. These types let a bare
   {toolId} list still be judged on output shape — the catalogue itself stays on the studio side. */
const TYPES_BY_ID = {
  'pdf-text': { in: 'pdf', out: 'txt' }, 'pdf-rasterize': { in: 'pdf', out: 'png' },
  'text-pdf': { in: 'txt', out: 'pdf' }, 'md-html': { in: 'md', out: 'html' },
  'html-md': { in: 'html', out: 'md' }, 'html-text': { in: 'html', out: 'txt' },
  'text-md': { in: 'txt', out: 'md' }, 'md-pdf': { in: 'md', out: 'pdf' },
  'docx-text': { in: 'docx', out: 'txt' }, 'text-docx': { in: 'txt', out: 'docx' },
  'xlsx-csv': { in: 'xlsx', out: 'csv' }, 'csv-xlsx': { in: 'csv', out: 'xlsx' },
  'csv-md': { in: 'csv', out: 'md' }, 'png-decode': { in: 'png', out: 'rgba' },
  'png-encode': { in: 'rgba', out: 'png' }, 'png-resize': { in: 'png', out: 'png' },
  'png-quality': { in: 'png', out: 'png' }, 'zip-pack': { in: 'files', out: 'zip' },
  'zip-unpack': { in: 'zip', out: 'files' }, ocr: { in: 'png', out: 'txt' },
  'docx-pdf-soffice': { in: 'docx', out: 'pdf' }, 'xlsx-recalc': { in: 'xlsx', out: 'xlsx' },
  'office-text': { in: 'doc', out: 'txt' }, 'rename-avif': { in: 'png', out: 'png' },
  summarize: { in: 'txt', out: 'txt' }, 'png-tables': { in: 'png', out: 'csv-of-tables' },
};

function normSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((s) => ({
    toolId: String(s.toolId || s.id || ''),
    params: s.params || (s.quality !== undefined ? { quality: s.quality } : {}),
    in: s.in || s.inType || null,
    out: s.out || s.outType || (TYPES_BY_ID[s.toolId] ? TYPES_BY_ID[s.toolId].out : null),
  }));
}

await window.mc.registerTool({
  name: 'score_pipeline',
  title: 'Score a pipeline against the trap catalogue',
  description: 'External oracle. Input {steps:[{toolId,params?}], notes?, inputType?, outputType?}. ' +
    'Returns {score, penalty, stars, hits:[{trapId,severity,weight,title,lesson}], engine, oracle}. ' +
    'notes carries runtime evidence (emptyOutput, magicMismatch, emptyResult, qualityIgnored) so ' +
    'execution-class traps can fire on what actually happened, not on what the plan claimed.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered transforms, each {toolId, params?}',
        items: { type: 'object', properties: { toolId: { type: 'string' }, params: { type: 'object' } }, required: ['toolId'] },
      },
      notes: { type: 'object', description: 'Runtime evidence from a real run' },
      inputType: { type: 'string' },
      outputType: { type: 'string' },
      mode: { type: 'string', enum: ['clamp', 'raw'], description: 'raw allows negative scores' },
    },
    required: ['steps'],
  },
  annotations: { readOnlyHint: true },
  execute: async (input) => {
    callCount++;
    paintCalls();
    const steps = normSteps(input && input.steps);
    const res = scoreTraps(steps, (input && input.notes) || {}, {
      inputType: input && input.inputType,
      outputType: input && input.outputType,
      mode: input && input.mode,
    });
    return {
      ok: true,
      score: res.score,
      penalty: res.penalty,
      stars: res.stars,
      passScore: PASS_SCORE,
      hits: res.hits,
      engine: TRAP_ENGINE,
      oracle: ORACLE,
      stepsSeen: steps.map((s) => s.toolId),
      calls: callCount,
    };
  },
}, { exposedTo: [mainOrigin] });

await window.mc.registerTool({
  name: 'trap_list',
  title: 'Trap catalogue',
  description: 'List the trap catalogue (optionally one trap by id). Returns {count, traps:[{id,severity,weight,title,pattern,lesson}]} with severity weights so a caller can recompute any score by hand.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Optional single trap id, e.g. T01' } },
  },
  annotations: { readOnlyHint: true },
  execute: async (input) => {
    const rows = TRAPS.map((t) => ({
      id: t.id,
      severity: t.severity,
      weight: SEVERITY_WEIGHT[t.severity],
      title: t.title,
      pattern: t.pattern,
      lesson: t.lesson,
    }));
    const id = input && input.id;
    if (id) {
      const one = rows.find((r) => r.id === String(id).toUpperCase());
      return one ? { ok: true, count: 1, trap: one, oracle: ORACLE } : { ok: false, error: 'no trap ' + id, oracle: ORACLE, count: 0, trap: null };
    }
    return { ok: true, count: rows.length, traps: rows, engine: TRAP_ENGINE, oracle: ORACLE };
  },
}, { exposedTo: [mainOrigin] });

/* Deliberately NOT exposed to the studio: proves default-invisible semantics, and models the
   internal cache-warm call a real oracle service would never hand to a client. */
await window.mc.registerTool({
  name: 'warm_cache',
  title: 'Warm the scoring cache (internal)',
  description: 'Internal scorer maintenance call. Not exposed to the studio origin — registered without exposedTo.',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
  execute: async () => ({ ok: true, warmed: true, oracle: ORACLE }),
});

window.__appReady = true;
paint();

function paint() {
  document.getElementById('mode').textContent = 'engine: ' + TRAPS.length + ' traps · ' + TRAP_ENGINE.split('·')[0].trim();
  document.getElementById('traps').textContent = 'weights: ' + Object.entries(SEVERITY_WEIGHT).map(([k, v]) => k + '=' + v).join(' ');
  document.getElementById('ready').textContent = 'tools ready: score_pipeline, trap_list (+1 unexposed)';
  document.getElementById('engine').textContent = TRAP_ENGINE;
  const rows = document.getElementById('rows');
  rows.innerHTML = '';
  for (const t of TRAPS) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><code>' + t.id + '</code></td>' +
      '<td class="sev-' + t.severity + '">' + t.severity + '</td>' +
      '<td>' + (SEVERITY_WEIGHT[t.severity] ?? '-') + '</td>' +
      '<td><strong>' + t.title + '</strong><br>' + t.pattern + '</td>';
    rows.appendChild(tr);
  }
}
function paintCalls() {
  const el = document.getElementById('calls');
  if (el) el.textContent = 'score_pipeline calls: ' + callCount;
}
