/* src/tools.js — every WebMCP tool the studio registers on the top-level page.
 * Rules: validate in code (the browser validates nothing against inputSchema); RETURN
 * {ok:false, error:{code, message, hint}} for every expected failure, never throw; keep results
 * compact; every invocation is logged to the agent-surface panel; a wrong target is an error,
 * never a silent success on something else. The human buttons call these same tools. */

import { CATALOG, BY_ID, INPUTS, GOALS } from './catalog.js';
import { validatePipeline, runPipeline } from './engine.js';
import { propose, planChain } from './proposer.js';
import { bytesFromB64, b64FromBytes, textEncode, sniffMagic } from './bytes.js';
import {
  store, newPipeline, byId, pick, addStep, removeStep, deletePipeline, setScore, recordRun,
  fixtureByName, putFixture, defaultFixtureFor, logInvocation,
} from './state.js';
import { SCORER_ORIGIN, VIA, callOracle, scorePipeline, fail, trapById } from './oracle.js';
import { logLine, logArtifact, renderSettled } from './ui.js';

const TOOL_ID_RE = /^[a-z0-9-]{1,40}$/;
const NAME_RE = /^[^\x00-\x1f\x7f]{1,60}$/u;
const FIXTURE_TYPES = ['pdf', 'docx', 'xlsx', 'png', 'md', 'html', 'csv', 'txt', 'zip', 'doc', 'scan', 'unknown'];
const ORIGINS = ['agent', 'human', 'seeded'];
const SNIFF_TO_TYPE = { png: 'png', zip: 'zip', pdf: 'pdf', text: 'txt', 'xml-or-html': 'html', jpeg: 'unknown', gif: 'unknown', avif: 'unknown', unknown: 'unknown' };
const MAX_INLINE_B64 = 32 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const catalogIds = () => CATALOG.map((t) => t.id).join(', ');

/* ---------------------------------------------------------------- views */

function hitsView(score) {
  return score && score.hits ? score.hits.map((h) => ({ trapId: h.trapId, severity: h.severity, weight: h.weight, basis: h.basis })) : null;
}

function viewPipeline(p) {
  return {
    id: p.id,
    name: p.name,
    inputType: p.inputType,
    outputType: p.outputType,
    origin: p.origin,
    steps: p.steps.map((s) => (Object.keys(s.params || {}).length ? { toolId: s.toolId, params: s.params } : { toolId: s.toolId })),
    selfScore: p.selfScore,
    score: p.lastScore ? p.lastScore.score : null,
    hits: hitsView(p.lastScore),
    lastRun: p.lastRun ? { ok: p.lastRun.ok, ms: p.lastRun.ms, notes: Object.keys(p.lastRun.notes || {}) } : null,
  };
}

function verdictView(res) {
  if (res.ok === false) return res;
  return {
    ok: true,
    score: res.score,
    penalty: res.penalty,
    stars: res.stars,
    hits: res.hits.map((h) => ({ trapId: h.trapId, severity: h.severity, weight: h.weight, title: h.title, basis: h.basis })),
    evidence: res.evidence,
    artifactSent: res.artifactSent === true,
    measurementNote: res.artifactSent === true
      ? 'artifact bytes were sent: hits labelled basis "measured" were re-sniffed by the oracle.'
      : 'no artifact bytes were sent (the pipeline has not been run, or it ended in a text document, which carries no bytes), so every hit rests on the plan or on notes. basis "measured" is reachable only for binary artifacts: pdf, png, docx, zip.',
    oracle: res.oracle,
    via: res.via,
  };
}

/* ---------------------------------------------------------- validation */

/** Resolve pipelineId: absent → the selected pipeline; present but unknown → not_found. */
function resolvePipeline(input) {
  if (input.pipelineId === undefined || input.pipelineId === null || input.pipelineId === '') {
    const p = pick();
    return p ? { p } : { error: fail('wrong_state', 'no pipeline exists yet', 'create one with pipeline_build or pipeline_propose') };
  }
  if (typeof input.pipelineId !== 'string') return { error: fail('invalid_param', 'pipelineId must be a string like "p3"', 'read ids from pipeline_list') };
  const p = byId(input.pipelineId);
  if (!p) return { error: fail('not_found', 'no pipeline ' + input.pipelineId, 'known ids: ' + (store.pipelines.map((x) => x.id).join(', ') || 'none')) };
  return { p };
}

function normaliseSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: fail('invalid_param', 'steps must be a non-empty array', 'e.g. steps: ["docx-text", "text-md"]') };
  const steps = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const toolId = typeof s === 'string' ? s : (isObject(s) ? s.toolId : undefined);
    if (typeof toolId !== 'string' || !TOOL_ID_RE.test(toolId)) return { error: fail('invalid_param', 'steps[' + i + '] has no usable toolId', 'each step is a toolId string or {toolId, params?}; see catalog_list') };
    if (isObject(s) && s.params !== undefined && !isObject(s.params)) return { error: fail('invalid_param', 'steps[' + i + '].params must be an object', 'e.g. {toolId:"png-quality", params:{quality:80}}') };
    steps.push({ toolId, params: isObject(s) && s.params ? s.params : {} });
  }
  return { steps };
}

function optionalString(input, key, hint) {
  const v = input[key];
  if (v === undefined || v === null) return { value: undefined };
  if (typeof v !== 'string') return { error: fail('invalid_param', key + ' must be a string', hint) };
  return { value: v };
}

function optionalEnum(input, key, values, fallback) {
  const v = input[key];
  if (v === undefined || v === null) return { value: fallback };
  if (!values.includes(v)) return { error: fail('invalid_param', key + ' must be one of ' + values.join(' | '), 'received ' + JSON.stringify(v).slice(0, 60)) };
  return { value: v };
}

/* ------------------------------------------------------------ runners */

function consoleRunEvents(ev) {
  if (ev.phase === 'start') logLine('dim', '  ' + ev.step + '. ' + ev.label + ' [' + ev.mode + '] …');
  else if (ev.phase === 'end') {
    const noteKeys = Object.keys(ev.notes || {});
    logLine('ok', '  ' + ev.step + '. ' + ev.label + ' ok · ' + ev.bytesIn + 'B → ' + ev.bytesOut + 'B · ' + ev.ms + 'ms' +
      (ev.magic ? ' · ' + ev.magic : '') + (noteKeys.length ? ' · observed: ' + noteKeys.join(',') : ''));
    if (ev.artifact && ev.artifact.kind === 'png') logArtifact(ev.artifact.dataUrl, ev.artifact.bytes);
  } else {
    logLine('err', '  ' + ev.step + '. ' + ev.label + ' FAILED: ' + ev.error +
      (Object.keys(ev.notes || {}).length ? ' · observed: ' + Object.keys(ev.notes).join(',') : ''));
  }
}

async function scoreAndStore(p, options) {
  const res = await scorePipeline(p, options);
  if (res.ok === false) {
    logLine('err', 'score ' + p.id + ' → ' + res.error.code + ': ' + res.error.message);
    return res;
  }
  setScore(p, res);
  logLine(res.hits.length ? 'err' : 'ok', 'score ' + p.id + ' → ' + res.score + '/100 via ' + res.oracle +
    ' · hits ' + (res.hits.map((h) => h.trapId + '(' + h.basis + ')').join(',') || 'none') + ' (−' + res.penalty + ')');
  return res;
}

export function knownBadProposal() {
  return {
    name: 'Known-bad: scan → ocr → tables',
    inputType: 'scan',
    outputType: 'csv-of-tables',
    selfScore: 93,
    rationale: 'Paint the page, OCR the pixels, read the tables out of the scan. Every step reports success, which is exactly the failure class we are testing for.',
    steps: [{ toolId: 'pdf-rasterize', params: {} }, { toolId: 'ocr', params: {} }, { toolId: 'png-tables', params: {} }],
  };
}

export function knownGoodProposal() {
  return {
    name: 'Known-good: docx → md (via zip)',
    inputType: 'docx',
    outputType: 'md',
    selfScore: 100,
    rationale: 'Open the OOXML package, inflate word/document.xml, walk the runs, then re-impose heading structure. Nothing is rendered, nothing is guessed.',
    steps: [{ toolId: 'docx-text', params: {} }, { toolId: 'text-md', params: {} }],
  };
}

export async function seedPipeline(proposal, origin) {
  const p = newPipeline({
    name: proposal.name,
    steps: proposal.steps,
    inputType: proposal.inputType,
    outputType: proposal.outputType,
    origin,
    selfScore: proposal.selfScore,
    agentRationale: proposal.rationale,
  });
  const verdict = await scoreAndStore(p, {});
  return { p, verdict };
}

/* ------------------------------------------------------ registration */

const controllers = { del: null };

/** Wrap execute: never throw, never return undefined, log every invocation. */
function guarded(name, fn) {
  return async (input, opts) => {
    const t0 = performance.now();
    const safeInput = isObject(input) ? input : {};
    let result;
    try {
      result = await fn(safeInput, opts && opts.signal ? opts.signal : null);
    } catch (err) {
      result = fail('wrong_state', 'unexpected failure in ' + name + ': ' + String(err && err.message ? err.message : err), 'retry with a well-formed input; the invocation log has the details');
    }
    if (result === undefined || result === null) result = fail('wrong_state', name + ' produced no result', 'retry');
    await renderSettled(); // never claim success for something the page has not shown yet
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    logInvocation({ n: store.log.length + 1, name, ok: result.ok !== false, ms, input: JSON.stringify(safeInput).slice(0, 600), output: JSON.stringify(result), at: Date.now() });
    return result;
  };
}

function tool(def, options) {
  def.execute = guarded(def.name, def.execute);
  return window.mc.registerTool(def, options);
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false };

export async function registerTools() {
  await tool({
    name: 'catalog_list',
    title: 'Transform catalogue',
    description: 'List the transforms a pipeline can use, each tagged mode "real" (executes in this tab on real bytes) or "simulated" (deterministic stand-in, badged in the UI) with the trap ids it is known to trigger. Returns {count, real, simulated, transforms:[{id, in, out, mode, traps}]}. Use step_explain for one transform in depth. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['real', 'simulated', 'all'], description: 'Filter by engine honesty. Default all.' },
        io: { type: 'string', description: 'Only transforms that consume or produce this type, e.g. "pdf".' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const mode = optionalEnum(input, 'mode', ['real', 'simulated', 'all'], 'all');
      if (mode.error) return mode.error;
      const io = optionalString(input, 'io', 'e.g. io: "png"');
      if (io.error) return io.error;
      let rows = CATALOG.slice();
      if (mode.value !== 'all') rows = rows.filter((t) => t.mode === mode.value);
      if (io.value) rows = rows.filter((t) => t.in === io.value || t.out === io.value);
      if (!rows.length) return fail('empty_result', 'no transform matches io=' + io.value, 'types in the catalogue: ' + [...new Set(CATALOG.flatMap((t) => [t.in, t.out]))].join(', '));
      return {
        ok: true,
        count: rows.length,
        real: rows.filter((t) => t.mode === 'real').length,
        simulated: rows.filter((t) => t.mode === 'simulated').length,
        transforms: rows.map((t) => ({ id: t.id, in: t.in, out: t.out, mode: t.mode, traps: t.traps || [] })),
      };
    },
  });

  await tool({
    name: 'step_explain',
    title: 'Explain one transform',
    description: 'Dossier on a single transform: what actually executes (engine), its real/simulated badge, its input and output types, accepted params, and every trap it is implicated in with severity, weight and lesson as published by the oracle origin. Returns {toolId, label, mode, engine, detail, in, out, params, traps}. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { toolId: { type: 'string', description: 'Transform id from catalog_list, e.g. "pdf-text".' } },
      required: ['toolId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      if (typeof input.toolId !== 'string') return fail('invalid_param', 'toolId must be a string', 'ids: ' + catalogIds());
      const def = BY_ID[input.toolId];
      if (!def) return fail('not_found', 'unknown toolId ' + input.toolId, 'ids: ' + catalogIds());
      const traps = (def.traps || []).map((id) => trapById(id) || { id, title: '(oracle catalogue not loaded)' })
        .map((t) => ({ id: t.id, severity: t.severity, weight: t.weight, title: t.title, lesson: t.lesson }));
      return {
        ok: true, toolId: def.id, label: def.label, mode: def.mode, in: def.in, out: def.out,
        engine: def.engine, detail: def.detail || null, params: def.params || {}, traps,
      };
    },
  });

  await tool({
    name: 'fixture_list',
    title: 'List fixtures',
    description: 'List the fixtures a pipeline can run on: name, declared type, byte size and the magic bytes the studio sniffed. Returns {count, fixtures:[{name, type, bytes, magic}]}; format "detailed" adds what each fixture is for. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { format: { type: 'string', enum: ['concise', 'detailed'], description: 'detailed adds the note field. Default concise.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => {
      const format = optionalEnum(input, 'format', ['concise', 'detailed'], 'concise');
      if (format.error) return format.error;
      return {
        ok: true,
        count: store.fixtures.length,
        fixtures: store.fixtures.map((f) => {
          const row = {
            name: f.name,
            type: f.type || f.kind,
            bytes: f.bytes ? f.bytes.length : (f.text != null ? textEncode(f.text).length : (f.files ? f.files.reduce((a, x) => a + x.bytes, 0) : 0)),
            magic: f.bytes ? sniffMagic(f.bytes).magic : (f.files ? f.files.length + ' parts' : 'text'),
          };
          if (format.value === 'detailed') row.note = f.note;
          return row;
        }),
      };
    },
  });

  await tool({
    name: 'fixture_upload',
    title: 'Add a fixture',
    description: 'Register a fixture from base64 bytes or plain text so pipelines can run on it; replaces a fixture of the same name. The bytes are magic-sniffed and the sniff is reported next to the declared type — a .docx whose magic is not ZIP is the renamed-file trap. Returns {name, bytes, sniffed, declaredType, mismatch}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Fixture name, letters/digits/._- only, e.g. "invoice-scan".' },
        b64: { type: 'string', description: 'Base64 file bytes (a data: URL prefix is allowed). Use this or text.' },
        text: { type: 'string', description: 'Plain text content. Use this or b64.' },
        type: { type: 'string', enum: FIXTURE_TYPES, description: 'Declared type, e.g. "docx". Defaults to the type implied by the magic bytes.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input) => {
      if (typeof input.name !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(input.name)) return fail('invalid_param', 'name must match [A-Za-z0-9._-]{1,40}', 'e.g. name: "invoice-scan"');
      const hasB64 = typeof input.b64 === 'string' && input.b64.length > 0;
      const hasText = typeof input.text === 'string';
      if (hasB64 === hasText) return fail('invalid_param', 'send exactly one of b64 or text', 'b64 for binary files, text for plain text');
      let bytes;
      try { bytes = hasB64 ? bytesFromB64(input.b64) : textEncode(input.text); } catch (e) {
        return fail('invalid_param', 'b64 is not valid base64', 'base64-encode the raw file bytes');
      }
      if (!bytes.length) return fail('invalid_param', 'the fixture is empty (0 bytes)', 'send non-empty content');
      const type = optionalEnum(input, 'type', FIXTURE_TYPES, null);
      if (type.error) return type.error;
      const sniffed = sniffMagic(bytes);
      const declaredType = type.value || SNIFF_TO_TYPE[sniffed.type] || 'unknown';
      const expect = { png: 'png', pdf: 'pdf', docx: 'zip', xlsx: 'zip', zip: 'zip' }[declaredType];
      const mismatch = !!expect && sniffed.type !== expect;
      const rec = { name: input.name, type: declaredType, bytes, note: 'uploaded · sniffed "' + sniffed.magic + '"' + (mismatch ? ' · DECLARED ' + declaredType : '') };
      if (hasText) rec.text = input.text;
      putFixture(rec);
      logLine(mismatch ? 'err' : 'ok', 'fixture +' + rec.name + ' · ' + bytes.length + 'B · magic ' + sniffed.magic + ' · declared ' + declaredType + (mismatch ? ' (MISMATCH)' : ''));
      return { ok: true, name: rec.name, bytes: bytes.length, sniffed: { type: sniffed.type, magic: sniffed.magic, confident: sniffed.confident }, declaredType, mismatch, count: store.fixtures.length };
    },
  });

  await tool({
    name: 'pipeline_list',
    title: 'List pipelines',
    description: 'List every pipeline on the canvas with its id, name, step ids, input/output types, the oracle score and trap hits if scored, and the proposer\'s self-score. Returns {count, selected, pipelines:[...]}. Read-only.',
    inputSchema: noArgs,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async () => ({ ok: true, count: store.pipelines.length, selected: store.selected, pipelines: store.pipelines.map(viewPipeline) }),
  });

  await tool({
    name: 'pipeline_plan',
    title: 'Plan a chain',
    description: 'Find the shortest chain of catalogue transforms that turns inputType into outputType, without creating anything. Returns {steps:[toolId], chain:[types]} or an empty_result error naming the types the catalogue does reach. Read-only; follow with pipeline_build.',
    inputSchema: {
      type: 'object',
      properties: {
        inputType: { type: 'string', enum: INPUTS.map((i) => i.type).filter((v, i, a) => a.indexOf(v) === i), description: 'Type entering the chain, e.g. "docx".' },
        outputType: { type: 'string', enum: GOALS.map((g) => g.type).concat(['rgba', 'files']), description: 'Type the chain must end at, e.g. "md".' },
      },
      required: ['inputType', 'outputType'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      if (typeof input.inputType !== 'string' || typeof input.outputType !== 'string') return fail('invalid_param', 'inputType and outputType must be strings', 'e.g. {inputType:"docx", outputType:"md"}');
      const chain = planChain(input.inputType, input.outputType);
      if (!chain) return fail('empty_result', 'no chain in the catalogue reaches ' + input.outputType + ' from ' + input.inputType, 'catalog_list io="' + input.inputType + '" shows what consumes that type; build the chain by hand with pipeline_build');
      const types = [input.inputType, ...chain.map((s) => BY_ID[s.toolId].out)];
      return { ok: true, inputType: input.inputType, outputType: input.outputType, steps: chain.map((s) => s.toolId), chain: types };
    },
  });

  await tool({
    name: 'pipeline_build',
    title: 'Build a pipeline',
    description: 'Create a pipeline card on the canvas from an ordered step list and select it. Unknown toolIds are kept and reported in the returned validation so you can fix them. Returns {pipeline:{id, steps, ...}, validation:{valid, errors, chain}}. Score it with pipeline_score; run it with pipeline_run.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', description: 'Ordered transforms; each item is a toolId string OR {toolId, params}, e.g. ["docx-text", {"toolId":"png-quality","params":{"quality":80}}].', items: { anyOf: [{ type: 'string', description: 'Transform id on its own, e.g. "docx-text" (same as {"toolId":"docx-text"}).' }, { type: 'object', properties: { toolId: { type: 'string', description: 'Transform id, e.g. "pdf-text".' }, params: { type: 'object', description: 'Step parameters, e.g. {"quality": 80}.' } }, required: ['toolId'], additionalProperties: true }] } },
        inputType: { type: 'string', description: 'Type entering the chain, e.g. "pdf". Defaults to the first step\'s input.' },
        outputType: { type: 'string', description: 'Goal type, e.g. "txt". Defaults to the last step\'s output.' },
        name: { type: 'string', description: 'Card title, up to 60 chars, e.g. "invoice to csv".' },
        origin: { type: 'string', enum: ORIGINS, description: 'Who proposed it. Default agent.' },
        selfScore: { type: 'number', description: 'Your own 0-100 confidence; the card shows the gap to the oracle score.' },
        rationale: { type: 'string', description: 'One sentence on why this chain, shown on the card.' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input) => {
      const norm = normaliseSteps(input.steps);
      if (norm.error) return norm.error;
      const origin = optionalEnum(input, 'origin', ORIGINS, 'agent');
      if (origin.error) return origin.error;
      for (const key of ['inputType', 'outputType', 'name', 'rationale']) {
        const v = optionalString(input, key, key + ' is free text');
        if (v.error) return v.error;
      }
      if (input.name !== undefined && !NAME_RE.test(input.name)) return fail('invalid_param', 'name must be 1-60 printable characters', 'e.g. name: "invoice to csv"');
      if (input.selfScore !== undefined && !(Number.isFinite(Number(input.selfScore)) && Number(input.selfScore) >= 0 && Number(input.selfScore) <= 100)) return fail('invalid_param', 'selfScore must be a number 0-100', 'omit it if you have no confidence estimate');
      const first = BY_ID[norm.steps[0].toolId];
      const last = BY_ID[norm.steps[norm.steps.length - 1].toolId];
      const p = newPipeline({
        steps: norm.steps,
        name: input.name || (first && last ? first.label + ' chain' : 'Pipeline'),
        inputType: input.inputType || (first ? first.in : 'txt'),
        outputType: input.outputType || (last ? last.out : 'txt'),
        origin: origin.value,
        selfScore: input.selfScore === undefined ? null : Number(input.selfScore),
        agentRationale: input.rationale ? String(input.rationale).slice(0, 300) : null,
      });
      logLine('head', '✂ built ' + p.id + ' (' + origin.value + '): ' + p.inputType + ' → ' + p.outputType + ' · ' + p.steps.map((s) => s.toolId).join(' → '));
      const v = validatePipeline(p);
      return { ok: true, pipeline: viewPipeline(p), validation: { valid: v.ok, errors: v.errors, warnings: v.warnings.length, chain: v.chain } };
    },
  });

  await tool({
    name: 'pipeline_add_step',
    title: 'Append a transform',
    description: 'Append (or insert at position) one transform into a pipeline; this is what clicking a palette card does. The pipeline\'s goal type becomes the last step\'s output and any previous score is cleared. Returns the updated {pipeline}. pipelineId defaults to the selected pipeline; an unknown id is an error, never a different target.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Target pipeline id, e.g. "p3". Defaults to the selected pipeline.' },
        toolId: { type: 'string', description: 'Transform id from catalog_list, e.g. "text-md".' },
        position: { type: 'integer', minimum: 0, description: '0-based insert index. Default: append.' },
        params: { type: 'object', description: 'Step parameters, e.g. {"quality": 80} or {"w": 640, "h": 480}.' },
      },
      required: ['toolId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: async (input) => {
      const r = resolvePipeline(input);
      if (r.error) return r.error;
      if (typeof input.toolId !== 'string' || !BY_ID[input.toolId]) return fail('not_found', 'unknown toolId ' + String(input.toolId), 'ids: ' + catalogIds());
      let position;
      if (input.position !== undefined) {
        position = Number(input.position);
        if (!Number.isInteger(position) || position < 0) return fail('invalid_param', 'position must be a non-negative integer', 'omit position to append');
      }
      if (input.params !== undefined && !isObject(input.params)) return fail('invalid_param', 'params must be an object', 'e.g. params: {quality: 80}');
      addStep(r.p, input.toolId, input.params, position);
      logLine('dim', '+ ' + input.toolId + ' → ' + r.p.id + (position !== undefined ? ' at ' + position : ''));
      return { ok: true, pipeline: viewPipeline(r.p) };
    },
  });

  await tool({
    name: 'pipeline_remove_step',
    title: 'Remove a step',
    description: 'Remove the step at a 0-based position from a pipeline (the card\'s ✕ button); the goal type follows the new last step and the score is cleared. Returns {removed, pipeline}. pipelineId defaults to the selected pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Target pipeline id, e.g. "p3". Defaults to the selected pipeline.' },
        position: { type: 'integer', minimum: 0, description: '0-based index of the step to remove, e.g. 1.' },
      },
      required: ['position'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: async (input) => {
      const r = resolvePipeline(input);
      if (r.error) return r.error;
      const position = Number(input.position);
      if (!Number.isInteger(position) || position < 0 || position >= r.p.steps.length) return fail('invalid_param', 'position must be an integer in 0..' + Math.max(0, r.p.steps.length - 1), r.p.id + ' has ' + r.p.steps.length + ' step(s)');
      const removed = removeStep(r.p, position);
      return { ok: true, removed: removed.toolId, pipeline: viewPipeline(r.p) };
    },
  });

  await tool({
    name: 'pipeline_validate',
    title: 'Validate the chain',
    description: 'Check a pipeline type-by-type without running it. Returns {valid, errors:[{kind, step, message, fix}], warnings:[{kind, message}], chain, endsAt, goal}. kinds: missing-connector (a step consumes a type the chain does not produce, fix names the connector), goal-mismatch, unknown-tool, empty; warnings flag simulated steps. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { pipelineId: { type: 'string', description: 'Pipeline id, e.g. "p3". Defaults to the selected pipeline.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const r = resolvePipeline(input);
      if (r.error) return r.error;
      const v = validatePipeline(r.p);
      logLine(v.ok ? 'ok' : 'err', 'validate ' + r.p.id + ' → ' + (v.ok ? 'chain sound' : v.errors.length + ' error(s): ' + v.errors.map((e) => e.kind).join(',')) + ' · ' + v.chain.join('→'));
      return { ok: true, pipelineId: r.p.id, valid: v.ok, errors: v.errors, warnings: v.warnings, chain: v.chain, endsAt: v.endsAt, goal: v.goal };
    },
  });

  await tool({
    name: 'pipeline_score',
    title: 'Score via the oracle',
    description: 'Send a pipeline to the scorer surface (the trap engine lives only under scorer/; this page has no scoring code) and store its verdict on the card. Sends the step list, the last run\'s notes and the last artifact\'s bytes; the oracle labels each hit basis "plan", "measured" (it re-sniffed bytes) or "claimed" (notes only). Only binary artifacts carry bytes, so "measured" is unreachable after a text run; see measurementNote. Returns {score, penalty, stars, hits, evidence, artifactSent}.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Pipeline id, e.g. "p3". Defaults to the selected pipeline.' },
        claims: { type: 'object', description: 'Extra evidence you assert, e.g. {"emptyOutput": true}; the oracle marks hits from it as claimed.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: async (input) => {
      const r = resolvePipeline(input);
      if (r.error) return r.error;
      if (input.claims !== undefined && !isObject(input.claims)) return fail('invalid_param', 'claims must be an object of evidence flags', 'e.g. claims: {magicMismatch: true}');
      const res = await scoreAndStore(r.p, { run: r.p.lastRun, claims: input.claims });
      if (res.ok === false) return res;
      return Object.assign({ pipelineId: r.p.id, selfScore: r.p.selfScore, gap: r.p.selfScore == null ? null : r.p.selfScore - res.score }, verdictView(res));
    },
  });

  await tool({
    name: 'pipeline_run',
    title: 'Execute on a fixture',
    description: 'Actually execute a pipeline in this tab: real steps process the fixture bytes, simulated steps are tagged. Streams to the run console, records the run, then (by default) asks the oracle to re-score with the observed notes and the artifact bytes. Returns {ok, steps:[{step, toolId, mode, ok, bytesIn, bytesOut, magic, ms, notes, error}], notes, artifact:{type, bytes, magic, preview}, verdict}. ok is false when any step failed. fixture defaults by input type; an unknown fixture is an error.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Pipeline id, e.g. "p3". Defaults to the selected pipeline.' },
        fixture: { type: 'string', description: 'Fixture name from fixture_list, e.g. "docx-memo". Defaults to the seeded fixture for the input type.' },
        scoreAfter: { type: 'boolean', description: 'Re-score through the oracle with the run evidence. Default true.' },
        format: { type: 'string', enum: ['concise', 'detailed'], description: 'detailed adds per-step meta plus artifact.b64 for binary artifacts under 32 KB; text artifacts have no bytes (b64 null + b64Note). Default concise.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, signal) => {
      const r = resolvePipeline(input);
      if (r.error) return r.error;
      const p = r.p;
      if (!p.steps.length) return fail('wrong_state', p.id + ' has no steps', 'add steps with pipeline_add_step or pipeline_plan first');
      const format = optionalEnum(input, 'format', ['concise', 'detailed'], 'concise');
      if (format.error) return format.error;
      if (input.scoreAfter !== undefined && typeof input.scoreAfter !== 'boolean') return fail('invalid_param', 'scoreAfter must be a boolean', 'omit it to re-score');
      let fixture;
      if (input.fixture === undefined || input.fixture === null || input.fixture === '') fixture = defaultFixtureFor(p.inputType);
      else if (typeof input.fixture !== 'string') return fail('invalid_param', 'fixture must be a fixture name', 'see fixture_list; upload bytes with fixture_upload first');
      else fixture = fixtureByName(input.fixture);
      if (!fixture) return fail('not_found', 'no fixture named ' + String(input.fixture), 'known: ' + store.fixtures.map((f) => f.name).join(', '));
      logLine('head', '▶ ' + p.name + ' (' + p.id + ') on ' + fixture.name + ' — ' + p.steps.map((s) => s.toolId).join(' → '));
      const run = await runPipeline(p, fixture, { onStep: consoleRunEvents, signal });
      recordRun(p, run, fixture.name);
      document.getElementById('run-note').textContent = 'last run: ' + p.id + ' on ' + fixture.name + ' · ' + (run.ok ? 'ok' : 'FAILED') + ' · ' + run.ms + 'ms';
      let verdict = null;
      if (input.scoreAfter !== false) {
        verdict = await scoreAndStore(p, { run });
        verdict = verdictView(verdict);
      }
      const steps = run.steps.map((s) => {
        const row = { step: s.step, toolId: s.toolId, mode: s.mode, ok: s.ok, bytesIn: s.bytesIn, bytesOut: s.bytesOut, magic: s.magic, ms: s.ms, notes: s.notes || {} };
        if (s.error) row.error = s.error;
        if (format.value === 'detailed') row.meta = s.meta || {};
        return row;
      });
      const artifact = Object.assign({}, run.artifact);
      if (format.value === 'detailed') {
        if (run.artifactBytes && run.artifactBytes.length <= MAX_INLINE_B64) artifact.b64 = b64FromBytes(run.artifactBytes);
        else {
          artifact.b64 = null;
          artifact.b64Note = run.artifactBytes
            ? 'artifact is larger than ' + MAX_INLINE_B64 + ' bytes; not inlined.'
            : 'this artifact is a text document, not bytes: read artifact.preview/artifact.chars instead. Oracle re-measurement (basis "measured") applies only to binary artifacts (pdf, png, docx, zip).';
        }
      }
      return { ok: run.ok, pipelineId: p.id, fixture: fixture.name, aborted: run.aborted, steps, notes: run.notes, ms: run.ms, finalType: run.finalType, artifact, verdict };
    },
  });

  await tool({
    name: 'pipeline_propose',
    title: 'Ask the scripted proposer',
    description: 'The scripted proposer (a pattern we watched an agent use, not a model) returns a pipeline for a goal in words plus its own confidence, then the oracle origin scores the same chain; the card shows the gap. Creates the pipeline unless build is false. Returns {pipeline, selfScore, oracleScore, gap, hits, rationale}.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you want, in words, e.g. "summarize the scanned pdf".' },
        build: { type: 'boolean', description: 'Also put the pipeline on the canvas. Default true.' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input) => {
      if (typeof input.goal !== 'string' || !input.goal.trim()) return fail('invalid_param', 'goal must be a non-empty string', 'e.g. goal: "convert docx into markdown notes"');
      if (input.build !== undefined && typeof input.build !== 'boolean') return fail('invalid_param', 'build must be a boolean', 'omit it to create the pipeline');
      const goal = input.goal.trim().slice(0, 200);
      const proposal = /scan|bad|worst|break/i.test(goal) ? knownBadProposal() : propose(goal);
      const shape = { steps: proposal.steps.map((s) => s.toolId), inputType: proposal.inputType, outputType: proposal.outputType };
      let verdict;
      let pipeline = null;
      if (input.build === false) {
        verdict = await scorePipeline({ steps: proposal.steps, inputType: proposal.inputType, outputType: proposal.outputType }, {});
      } else {
        const seeded = await seedPipeline(Object.assign({}, proposal, { name: proposal.name || ('Proposed: ' + goal.slice(0, 40)) }), 'agent');
        pipeline = viewPipeline(seeded.p);
        verdict = seeded.verdict;
      }
      if (verdict.ok === false) return verdict;
      return {
        ok: true, goal, rationale: proposal.rationale, selfScore: proposal.selfScore,
        oracleScore: verdict.score, gap: proposal.selfScore - verdict.score, hits: hitsView(verdict),
        scoredBy: verdict.oracle, via: verdict.via, proposal: shape, pipeline,
      };
    },
  });

  await tool({
    name: 'pipeline_seed_bad',
    title: 'Load the known-bad recipe',
    description: 'Seed the canvas with the pipeline we know breaks (input type "scan" → pdf-rasterize → ocr → png-tables) and return the oracle verdict; expect a low score with T01, T09 and T12 among the hits. Returns {pipelineId, steps, score, hits}.',
    inputSchema: noArgs,
    annotations: { readOnlyHint: false },
    execute: async () => {
      const { p, verdict } = await seedPipeline(knownBadProposal(), 'seeded');
      if (verdict.ok === false) return verdict;
      return { ok: true, pipelineId: p.id, steps: p.steps.map((s) => s.toolId), score: verdict.score, hits: hitsView(verdict), oracle: verdict.oracle };
    },
  });

  await tool({
    name: 'run_history',
    title: 'Recent runs',
    description: 'The run log, most recent first: [{at, pipelineId, name, fixture, steps, ok, ms, notes, artifact:{type, bytes, magic, preview}}]. Returns {count, runs}. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 60, description: 'How many runs to return, 1-60. Default 5.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => {
      let limit = 5;
      if (input.limit !== undefined) {
        limit = Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 60) return fail('invalid_param', 'limit must be an integer 1-60', 'omit limit for the 5 most recent runs');
      }
      return { ok: true, count: store.runs.length, runs: store.runs.slice(0, limit).map((r) => ({ at: r.at, pipelineId: r.pipelineId, name: r.name, fixture: r.fixture, steps: r.steps, ok: r.ok, ms: r.ms, notes: Object.keys(r.notes || {}), artifact: r.artifact ? { type: r.artifact.type, bytes: r.artifact.bytes, magic: r.artifact.magic || null, preview: r.artifact.preview ? r.artifact.preview.slice(0, 120) : null } : null })) };
    },
  });

  /* ---- bridges: ChatGPT's browser discovers top-level tools only, so the oracle origin's tools are
     mirrored here. The bridge relays through getTools({fromOrigins}) + executeTool and labels the origin. ---- */
  await tool({
    name: 'oracle_score_pipeline',
    title: 'Bridge: score_pipeline on the oracle origin',
    description: 'Bridge to the scorer origin\'s score_pipeline tool (agents that cannot see iframe tools use this). Relays your input unchanged through getTools({fromOrigins}) + executeTool and returns the oracle\'s reply plus {bridgedTo, from}. Same input as score_pipeline: steps (required), inputType, outputType, notes, artifact, mode, verbosity. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', description: 'Ordered transforms; each item is a toolId string OR {toolId, params}, e.g. ["docx-text", {"toolId":"png-quality","params":{"quality":80}}].', items: { anyOf: [{ type: 'string', description: 'Transform id on its own, e.g. "docx-text" (same as {"toolId":"docx-text"}).' }, { type: 'object', properties: { toolId: { type: 'string', description: 'Transform id, e.g. "pdf-text".' }, params: { type: 'object', description: 'Step parameters, e.g. {"quality": 80}.' } }, required: ['toolId'], additionalProperties: true }] } },
        inputType: { type: 'string', description: 'Type entering the chain, e.g. "pdf".' },
        outputType: { type: 'string', description: 'Goal type, e.g. "txt".' },
        notes: { type: 'object', description: 'Evidence you assert, e.g. {"emptyOutput": true}; hits from it are basis "claimed".' },
        artifact: { type: 'object', description: 'Artifact to re-measure: {"b64": "<base64>", "declaredType": "png"}.', properties: { b64: { type: 'string', description: 'Base64 of the artifact bytes.' }, declaredType: { type: 'string', description: 'Declared type, e.g. "pdf".' } }, additionalProperties: false },
        mode: { type: 'string', enum: ['clamp', 'raw'], description: 'clamp (default) floors at 0; raw allows negatives.' },
        verbosity: { type: 'string', enum: ['concise', 'full'], description: 'full adds lesson text to hits. Default concise.' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => Object.assign({ bridgedTo: 'score_pipeline', from: SCORER_ORIGIN, via: VIA }, await callOracle('score_pipeline', input)),
  });

  await tool({
    name: 'oracle_trap_list',
    title: 'Bridge: trap_list on the oracle origin',
    description: 'Bridge to the scorer origin\'s trap_list tool (agents that cannot see iframe tools use this). Relays your input unchanged and returns the oracle\'s reply plus {bridgedTo, from}: the catalogue with severity weights, or one trap by id. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One trap id, e.g. "T04". Omit to list all.' },
        format: { type: 'string', enum: ['concise', 'detailed'], description: 'detailed adds pattern and lesson. Default concise.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => Object.assign({ bridgedTo: 'trap_list', from: SCORER_ORIGIN, via: VIA }, await callOracle('trap_list', input)),
  });
}

/* ---- human-armed surface: deleting recipes is the one consequential action, so the tool only
   exists while a person has ticked the box. Register/unregister is visible via mc-toolchange. ---- */

export function deleteArmed() {
  return !!controllers.del;
}

export async function armDelete() {
  if (controllers.del) return;
  controllers.del = new AbortController();
  await tool({
    name: 'pipeline_delete',
    title: 'Delete a pipeline',
    description: 'Remove a pipeline card from the canvas by id; cannot be undone. Available only while a person has ticked "let agents delete recipes" (registered with an AbortSignal, so it disappears again when unticked). Returns {removed, remaining}.',
    inputSchema: {
      type: 'object',
      properties: { pipelineId: { type: 'string', description: 'Pipeline id to delete, e.g. "p3".' } },
      required: ['pipelineId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: async (input) => {
      if (typeof input.pipelineId !== 'string') return fail('invalid_param', 'pipelineId must be a string like "p3"', 'read ids from pipeline_list');
      if (!deletePipeline(input.pipelineId)) return fail('not_found', 'no pipeline ' + input.pipelineId, 'known ids: ' + (store.pipelines.map((x) => x.id).join(', ') || 'none'));
      logLine('dim', '✕ deleted ' + input.pipelineId);
      return { ok: true, removed: input.pipelineId, remaining: store.pipelines.length };
    },
  }, { signal: controllers.del.signal });
}

export function disarmDelete() {
  if (!controllers.del) return;
  controllers.del.abort();
  controllers.del = null;
}

