/* scorer/scorer.js — the external oracle: three WebMCP tools on their own origin.
 * The studio cannot import this engine (different origin, and it does not try to); it can only
 * call these tools through getTools({fromOrigins}) + executeTool. Two are exposed to the studio,
 * one is deliberately not. Nothing here trusts the caller: input is validated in code (the browser
 * does not validate against inputSchema), and every trap hit says whether the oracle measured the
 * evidence itself or merely repeated what the caller claimed. */

import { TRAPS, SEVERITY_WEIGHT, scoreTraps, TRAP_ENGINE, PASS_SCORE } from './traps.js';
import { sniffMagic, bytesFromB64 } from './bytes.js';

const MAIN_ORIGIN = window.MC.origin('main');
const ORACLE = 'scorer:' + window.location.origin;
const MAX_ARTIFACT_B64 = 512 * 1024;
const TOOL_ID_RE = /^[a-z0-9-]{1,40}$/;
const EXPECTED_MAGIC = { png: 'png', pdf: 'pdf', docx: 'zip', xlsx: 'zip', zip: 'zip', avif: 'avif', jpeg: 'jpeg', gif: 'gif' };

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

const state = { calls: 0, last: null };

const fail = (code, message, hint) => ({ ok: false, error: { code, message, hint }, oracle: ORACLE });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Strict step normalisation: strings or {toolId, params?} only. Returns {steps} or {error}. */
function normaliseSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: fail('invalid_param', 'steps must be a non-empty array', 'send steps: ["pdf-text"] or [{toolId:"png-quality", params:{quality:80}}]') };
  }
  const steps = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const toolId = typeof s === 'string' ? s : (isObject(s) ? s.toolId : undefined);
    if (typeof toolId !== 'string' || !TOOL_ID_RE.test(toolId)) {
      return { error: fail('invalid_param', 'steps[' + i + '] has no usable toolId', 'each step is a toolId string like "docx-text" or an object {toolId, params?}') };
    }
    const params = isObject(s) && isObject(s.params) ? s.params : {};
    const known = TYPES_BY_ID[toolId] || {};
    steps.push({
      toolId,
      params,
      in: (isObject(s) && typeof s.in === 'string' && s.in) || known.in || null,
      out: (isObject(s) && typeof s.out === 'string' && s.out) || known.out || null,
    });
  }
  return { steps };
}

/** What the oracle can verify by itself: byte length and magic bytes of the artifact it was handed. */
function measureArtifact(artifact) {
  if (artifact === undefined || artifact === null) return { measured: {}, seen: null };
  if (!isObject(artifact) || typeof artifact.b64 !== 'string') {
    return { error: fail('invalid_param', 'artifact must be {b64, declaredType?}', 'send the final artifact bytes as base64 so the oracle can re-sniff them') };
  }
  if (artifact.b64.length > MAX_ARTIFACT_B64) {
    return { error: fail('invalid_param', 'artifact.b64 exceeds ' + MAX_ARTIFACT_B64 + ' chars', 'send a smaller artifact or omit it') };
  }
  let bytes;
  try { bytes = bytesFromB64(artifact.b64); } catch (e) {
    return { error: fail('invalid_param', 'artifact.b64 is not valid base64', 'base64-encode the raw bytes (data: URL prefix is allowed)') };
  }
  const declaredType = typeof artifact.declaredType === 'string' ? artifact.declaredType.toLowerCase() : null;
  const measured = {};
  const sniff = sniffMagic(bytes);
  const seen = { bytes: bytes.length, magic: sniff.magic, magicType: sniff.type, declaredType };
  if (bytes.length === 0) measured.emptyOutput = 'artifact is 0 bytes (measured by the oracle)';
  const want = declaredType ? EXPECTED_MAGIC[declaredType] : null;
  if (want && bytes.length && sniff.type !== want) {
    measured.magicMismatch = 'declared ' + declaredType + ', magic bytes say "' + sniff.magic + '" (measured by the oracle)';
  }
  return { measured, seen };
}

function cleanNotes(notes) {
  if (notes === undefined || notes === null) return {};
  if (!isObject(notes)) return null;
  const out = {};
  for (const [k, v] of Object.entries(notes)) {
    if (v === false || v === null || v === undefined || v === '') continue;
    out[String(k).slice(0, 40)] = typeof v === 'string' ? v.slice(0, 160) : true;
  }
  return out;
}

async function scorePipeline(input) {
  input = isObject(input) ? input : {};
  const norm = normaliseSteps(input.steps);
  if (norm.error) return norm.error;
  const claimed = cleanNotes(input.notes);
  if (claimed === null) return fail('invalid_param', 'notes must be an object of evidence flags', 'e.g. notes: {emptyOutput: true, magicMismatch: "declared png, got zip"}');
  const art = measureArtifact(input.artifact);
  if (art.error) return art.error;
  if (input.mode !== undefined && input.mode !== 'clamp' && input.mode !== 'raw') {
    return fail('invalid_param', 'mode must be "clamp" or "raw"', 'omit mode for the clamped 0..100 score');
  }
  const verbosity = input.verbosity === undefined ? 'concise' : input.verbosity;
  if (verbosity !== 'concise' && verbosity !== 'full') return fail('invalid_param', 'verbosity must be "concise" or "full"', 'full adds the lesson text to every hit');
  const inputType = typeof input.inputType === 'string' ? input.inputType : undefined;
  const outputType = typeof input.outputType === 'string' ? input.outputType : undefined;
  const res = scoreTraps(norm.steps, { measured: art.measured, claimed }, { inputType, outputType, mode: input.mode });
  state.calls++;
  state.last = { score: res.score, hits: res.hits.map((h) => h.trapId + ':' + h.basis) };
  paint();
  return {
    ok: true,
    score: res.score,
    penalty: res.penalty,
    stars: res.stars,
    passScore: PASS_SCORE,
    hits: res.hits.map((h) => (verbosity === 'full' ? h : { trapId: h.trapId, severity: h.severity, weight: h.weight, title: h.title, basis: h.basis })),
    evidence: { measured: art.measured, claimed: Object.keys(claimed), artifactSeen: art.seen },
    stepsSeen: norm.steps.map((s) => s.toolId),
    engine: TRAP_ENGINE,
    oracle: ORACLE,
    calls: state.calls,
  };
}

async function trapList(input) {
  input = isObject(input) ? input : {};
  const format = input.format === undefined ? 'concise' : input.format;
  if (format !== 'concise' && format !== 'detailed') return fail('invalid_param', 'format must be "concise" or "detailed"', 'detailed adds pattern and lesson to every trap');
  const row = (t, detailed) => {
    const r = { id: t.id, severity: t.severity, weight: SEVERITY_WEIGHT[t.severity], title: t.title };
    if (detailed) { r.pattern = t.pattern; r.lesson = t.lesson; }
    return r;
  };
  if (input.id !== undefined) {
    if (typeof input.id !== 'string') return fail('invalid_param', 'id must be a string like "T04"', 'omit id to list every trap');
    const one = TRAPS.find((t) => t.id === input.id.toUpperCase());
    if (!one) return fail('not_found', 'no trap ' + input.id, 'ids run T01..T' + String(TRAPS.length).padStart(2, '0'));
    return { ok: true, count: 1, trap: row(one, true), oracle: ORACLE };
  }
  return { ok: true, count: TRAPS.length, weights: SEVERITY_WEIGHT, passScore: PASS_SCORE, traps: TRAPS.map((t) => row(t, format === 'detailed')), engine: TRAP_ENGINE, oracle: ORACLE };
}

/** Never let a handler throw: a throw is a bare UnknownError plus a console error natively. */
const guarded = (fn) => async (input) => {
  try {
    const r = await fn(input);
    return r === undefined ? fail('wrong_state', 'tool produced no result', 'retry') : r;
  } catch (e) {
    return fail('wrong_state', 'unexpected failure: ' + String(e && e.message ? e.message : e), 'retry with a well-formed input');
  }
};

async function registerTools() {
  await window.mc.registerTool({
    name: 'score_pipeline',
    title: 'Score a pipeline against the trap catalogue',
    description: 'External oracle on its own origin. Scores an ordered step list against ' + TRAPS.length + ' documented traps: ' +
      'score starts at ' + PASS_SCORE + ' and loses ' + SEVERITY_WEIGHT.high + '/' + SEVERITY_WEIGHT.medium + '/' + SEVERITY_WEIGHT.low +
      ' per high/medium/low hit. Returns {score, penalty, stars, hits:[{trapId, severity, weight, title, basis}], evidence, oracle}. ' +
      'basis is "plan" (step list alone), "measured" (the oracle re-sniffed the artifact bytes you sent) or "claimed" (only your notes say so). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered transforms; each item is a toolId string OR {toolId, params}, e.g. ["docx-text", {"toolId":"png-quality","params":{"quality":80}}].',
          items: { anyOf: [{ type: 'string', description: 'Transform id on its own, e.g. "docx-text" (same as {"toolId":"docx-text"}).' }, { type: 'object', properties: { toolId: { type: 'string', description: 'Transform id, e.g. "pdf-text".' }, params: { type: 'object', description: 'Step parameters, e.g. {"quality": 80}.' } }, required: ['toolId'], additionalProperties: true }] },
        },
        inputType: { type: 'string', description: 'Type entering the chain, e.g. "pdf". Defaults to the first step\'s input.' },
        outputType: { type: 'string', description: 'Goal type, e.g. "txt". Defaults to the last step\'s output.' },
        notes: { type: 'object', description: 'Evidence you assert, e.g. {"emptyOutput": true}. Hits that rest only on this are labelled basis "claimed".' },
        artifact: { type: 'object', description: 'Final artifact for re-measurement: {"b64","declaredType"}; hits from it are basis "measured". Only binary results (pdf/png/docx/zip) have bytes.', properties: { b64: { type: 'string', description: 'Base64 of the artifact bytes.' }, declaredType: { type: 'string', description: 'What the pipeline says it produced, e.g. "pdf".' } }, additionalProperties: false },
        mode: { type: 'string', enum: ['clamp', 'raw'], description: 'clamp (default) floors the score at 0; raw allows negative scores.' },
        verbosity: { type: 'string', enum: ['concise', 'full'], description: 'full adds the lesson text to every hit. Default concise.' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: guarded(scorePipeline),
  }, { exposedTo: [MAIN_ORIGIN] });

  await window.mc.registerTool({
    name: 'trap_list',
    title: 'Trap catalogue',
    description: 'List the oracle\'s trap catalogue with severity weights so any score can be recomputed by hand. Returns {count, weights, traps:[{id, severity, weight, title}]}; format "detailed" adds pattern and lesson; id returns one trap in full. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One trap id, e.g. "T04". Omit to list all.' },
        format: { type: 'string', enum: ['concise', 'detailed'], description: 'detailed adds pattern and lesson to every row. Default concise.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: guarded(trapList),
  }, { exposedTo: [MAIN_ORIGIN] });

  /* Deliberately NOT exposed: proves default-invisible cross-origin semantics, and models the
     internal cache-warm call a real oracle service would never hand to a client. In single-folder
     mode the oracle is same-origin with the studio, so this one becomes visible there — the spec
     makes same-origin frames transparent, and the studio badge says which mode it is in. */
  await window.mc.registerTool({
    name: 'warm_cache',
    title: 'Warm the scoring cache (internal)',
    description: 'Internal scorer maintenance call, registered without exposedTo. Returns {ok, warmed}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: guarded(async () => ({ ok: true, warmed: true, oracle: ORACLE })),
  });
}

/* ---------------- the oracle's own little page ---------------- */

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function paint() {
  $('mode').textContent = 'engine: ' + TRAPS.length + ' traps · ' + TRAP_ENGINE.split('·')[0].trim();
  $('binding').textContent = 'webmcp: ' + (window.MC.native ? 'native' : 'kit shim');
  $('traps').textContent = 'weights: ' + Object.entries(SEVERITY_WEIGHT).map(([k, v]) => k + '=' + v).join(' ');
  $('ready').textContent = 'exposed to ' + MAIN_ORIGIN + ': score_pipeline, trap_list (+1 unexposed)';
  $('calls').textContent = 'score_pipeline calls: ' + state.calls;
  $('last').textContent = state.last ? 'last verdict: ' + state.last.score + '/100 · ' + (state.last.hits.join(', ') || 'no hits') : 'last verdict: —';
  $('engine').textContent = TRAP_ENGINE;
}

function paintTable() {
  const rows = $('rows');
  rows.textContent = '';
  for (const t of TRAPS) {
    const tr = el('tr');
    tr.appendChild(el('td')).appendChild(el('code', '', t.id));
    tr.appendChild(el('td', 'sev-' + t.severity, t.severity));
    tr.appendChild(el('td', '', String(SEVERITY_WEIGHT[t.severity])));
    const td = tr.appendChild(el('td'));
    td.appendChild(el('strong', '', t.title));
    td.appendChild(el('br'));
    td.appendChild(document.createTextNode(t.pattern));
    rows.appendChild(tr);
  }
}

async function boot() {
  try {
    paintTable();
    await registerTools();
    paint();
  } catch (err) {
    window.__bootError = String(err && err.stack ? err.stack : err);
    $('mode').textContent = 'boot failed: ' + String(err && err.message ? err.message : err);
  }
  window.MC.ready();
}

boot();
