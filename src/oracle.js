/* src/oracle.js — the studio's only way to a verdict: the scorer origin's tools, discovered with
 * getTools({fromOrigins}) and executed with executeTool. There is no local engine to fall back
 * to; when the oracle is unreachable every score is an honest {ok:false, wrong_state}. */

import { BY_ID } from './catalog.js';
import { b64FromBytes } from './bytes.js';
import { store, touch } from './state.js';

export const SCORER_ORIGIN = window.MC.origin('scorer');
export const IS_MULTI = window.MC.isMulti;
export const SCORER_TOOLS = ['score_pipeline', 'trap_list'];
export const VIA = IS_MULTI ? 'fromOrigins(cross-origin)' : 'same-origin iframe (single-folder mode)';
const MAX_ARTIFACT_BYTES = 256 * 1024;

export const fail = (code, message, hint) => ({ ok: false, error: { code, message, hint } });

/** RegisteredTool objects the scorer exposes to us (by name). */
export async function oracleTools() {
  let tools = [];
  try {
    tools = await window.mc.getTools({ fromOrigins: [SCORER_ORIGIN] });
  } catch (e) {
    tools = [];
  }
  const mine = tools.filter((t) => t.origin === SCORER_ORIGIN && SCORER_TOOLS.includes(t.name));
  store.oracle.tools = mine.map((t) => t.name);
  store.oracle.reachable = mine.length === SCORER_TOOLS.length;
  return mine;
}

function parse(raw) {
  if (raw === null || raw === undefined) return fail('wrong_state', 'the oracle returned nothing (frame navigated away?)', 'reload the page and retry');
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (e) { return { ok: true, text: raw }; }
}

/** Execute one oracle tool. Never throws: unreachable → {ok:false, error:{code:'wrong_state'}}. */
export async function callOracle(name, input) {
  const tools = await oracleTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return fail('wrong_state', 'the oracle origin is not reachable (' + name + ' is not among the tools ' + SCORER_ORIGIN + ' exposes to this page)',
      'wait for the scorer iframe to load, then retry; the studio has no local engine to fall back to');
  }
  let res;
  try {
    res = parse(await window.mc.executeTool(tool, input || {}));
  } catch (err) {
    res = fail('wrong_state', 'oracle call failed: ' + String(err && err.message ? err.message : err), 'retry once the scorer frame has finished loading');
  }
  if (name === 'score_pipeline' && res && res.ok !== false) store.oracle.calls++;
  touch();
  return res;
}

/** Score a pipeline: the step list, what the last run observed (claimed), and the artifact bytes (measured). */
export async function scorePipeline(pipeline, options = {}) {
  const steps = (pipeline.steps || []).map((s) => ({
    toolId: s.toolId,
    params: s.params || {},
    in: BY_ID[s.toolId] ? BY_ID[s.toolId].in : null,
    out: BY_ID[s.toolId] ? BY_ID[s.toolId].out : null,
  }));
  if (!steps.length) return fail('empty_result', 'pipeline ' + (pipeline.id || '') + ' has no steps to score', 'add steps with pipeline_add_step or pipeline_plan first');
  const run = options.run || null;
  const notes = Object.assign({}, run ? run.notes : {}, options.claims || {});
  const payload = { steps, notes, inputType: pipeline.inputType, outputType: pipeline.outputType, verbosity: 'full' };
  if (run && run.artifactBytes && run.artifactBytes.length <= MAX_ARTIFACT_BYTES) {
    payload.artifact = { b64: b64FromBytes(run.artifactBytes), declaredType: run.artifact.declaredType || run.artifact.type };
  }
  const res = await callOracle('score_pipeline', payload);
  if (res.ok === false) return res;
  return Object.assign({ via: VIA, notesSent: Object.keys(notes), artifactSent: !!payload.artifact }, res);
}

/** The oracle's detailed catalogue, cached for inline card annotations. */
export async function loadTrapCatalogue() {
  const res = await callOracle('trap_list', { format: 'detailed' });
  store.oracle.traps = res.ok ? res.traps : [];
  touch();
  return store.oracle.traps;
}

export const trapById = (id) => store.oracle.traps.find((t) => t.id === id) || null;
