/* src/state.js — the one store for the studio origin, mutated only by the named functions below.
 * Every mutation ends with `touch()`, which fires 'change' on `bus`; main.js schedules one render
 * per animation frame from that. Tools and buttons both go through these mutators. */

import { BY_ID, INPUTS } from './catalog.js';

export const bus = new EventTarget();

export const store = {
  pipelines: [],
  runs: [],
  fixtures: [],
  seq: 1,
  selected: null,
  oracle: { reachable: false, calls: 0, traps: [], tools: [] },
  toolChanges: 0,
  log: [],
  errors: [],
};

export function touch() {
  bus.dispatchEvent(new Event('change'));
}

export function newPipeline(fields) {
  const p = Object.assign({
    id: 'p' + (store.seq++),
    name: 'Recipe ' + (store.seq - 1),
    inputType: 'txt',
    outputType: 'txt',
    steps: [],
    origin: 'human',
    agentRationale: null,
    selfScore: null,
    lastScore: null,
    lastRun: null,
    createdAt: Date.now(),
  }, fields);
  store.pipelines.push(p);
  store.selected = p.id;
  touch();
  return p;
}

export const byId = (id) => store.pipelines.find((p) => p.id === id) || null;

export function pick() {
  return byId(store.selected) || store.pipelines[store.pipelines.length - 1] || null;
}

export function select(id) {
  if (byId(id)) { store.selected = id; touch(); }
}

export function addStep(p, toolId, params, position) {
  const step = { toolId, params: params || {} };
  if (Number.isFinite(position)) p.steps.splice(Math.max(0, Math.min(p.steps.length, position)), 0, step);
  else p.steps.push(step);
  const last = BY_ID[p.steps[p.steps.length - 1].toolId];
  if (last) p.outputType = last.out;
  p.lastScore = null;
  touch();
  return step;
}

export function removeStep(p, index) {
  const [removed] = p.steps.splice(index, 1);
  const last = p.steps.length ? BY_ID[p.steps[p.steps.length - 1].toolId] : null;
  if (last) p.outputType = last.out;
  p.lastScore = null;
  touch();
  return removed;
}

/** Shared by the card's Delete button and the (human-armed) pipeline_delete tool. */
export function deletePipeline(id) {
  const i = store.pipelines.findIndex((p) => p.id === id);
  if (i === -1) return false;
  store.pipelines.splice(i, 1);
  if (store.selected === id) store.selected = store.pipelines.length ? store.pipelines[store.pipelines.length - 1].id : null;
  touch();
  return true;
}

export function setScore(p, verdict) {
  p.lastScore = verdict;
  touch();
}

export function recordRun(p, run, fixtureName) {
  p.lastRun = run;
  store.runs.unshift({
    at: Date.now(),
    pipelineId: p.id,
    name: p.name,
    fixture: fixtureName,
    steps: p.steps.map((s) => s.toolId),
    ok: run.ok,
    ms: run.ms,
    notes: run.notes,
    finalType: run.finalType,
    artifact: run.artifact,
  });
  if (store.runs.length > 60) store.runs.pop();
  touch();
}

export function clearRuns() {
  store.runs = [];
  touch();
}

export const fixtureByName = (name) => store.fixtures.find((f) => f.name === name) || null;

/** A fixture record replaces any earlier one with the same name (no stale fields survive). */
export function putFixture(rec) {
  const i = store.fixtures.findIndex((f) => f.name === rec.name);
  if (i === -1) store.fixtures.push(rec);
  else store.fixtures[i] = rec;
  touch();
  return rec;
}

export function defaultFixtureFor(type) {
  const input = INPUTS.find((i) => i.type === type);
  return (input && fixtureByName(input.fixture)) || store.fixtures[0] || null;
}

export function logInvocation(entry) {
  store.log.unshift(entry);
  if (store.log.length > 80) store.log.pop();
  touch();
}

/** Test-facing snapshot: plain data only, no byte buffers. */
export function snapshot() {
  return {
    selected: store.selected,
    pipelines: store.pipelines.map((p) => ({
      id: p.id, name: p.name, inputType: p.inputType, outputType: p.outputType, origin: p.origin,
      steps: p.steps.map((s) => ({ toolId: s.toolId, params: s.params })),
      selfScore: p.selfScore,
      score: p.lastScore ? p.lastScore.score : null,
      hits: p.lastScore && p.lastScore.hits ? p.lastScore.hits.map((h) => h.trapId + ':' + h.basis) : null,
      lastRunOk: p.lastRun ? p.lastRun.ok : null,
    })),
    runs: store.runs.length,
    fixtures: store.fixtures.map((f) => f.name),
    oracle: { reachable: store.oracle.reachable, calls: store.oracle.calls, traps: store.oracle.traps.length },
    toolChanges: store.toolChanges,
    log: store.log.map((l) => ({ name: l.name, ok: l.ok, ms: l.ms })),
    errors: store.errors.slice(),
  };
}
