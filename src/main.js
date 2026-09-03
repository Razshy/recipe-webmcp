/* src/main.js — boot and wiring only. The studio's rules: every button that changes tool-visible
 * state goes through window.__agent.call (the same handle the tests and the agent panel use);
 * nothing here claims a result it did not produce; the studio has no trap engine — every score
 * comes back from the oracle origin or is an honest error. */

import { INPUTS, CATALOG } from './catalog.js';
import { store, bus, deletePipeline, select, clearRuns, snapshot } from './state.js';
import { buildFixtures } from './fixtures.js';
import { SCORER_ORIGIN, IS_MULTI, loadTrapCatalogue } from './oracle.js';
import { registerTools, armDelete, disarmDelete, deleteArmed, seedPipeline, knownBadProposal, knownGoodProposal } from './tools.js';
import { renderSelects, renderPalette, renderToolList, renderAll, scheduleRender, logLine, clearConsole, showCall } from './ui.js';

const $ = (id) => document.getElementById(id);
const agent = (name, input) => window.__agent.call(name, input || {});

function reportError(where, err) {
  const text = where + ': ' + String(err && err.message ? err.message : err);
  store.errors.push(text);
  logLine('err', text);
}

/** A UI handler that awaits a tool call: rejection is handled, never an unhandled promise. */
const handled = (fn) => (ev) => Promise.resolve(fn(ev)).catch((err) => reportError('ui', err));

async function callAndShow(name, input) {
  const raw = await agent(name, input);
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch (e) { /* string result */ }
  showCall(name, parsed);
  return parsed;
}

function selectedFixture() {
  return $('fixture-id').value;
}

function wireUi() {
  $('btn-build').addEventListener('click', handled(async () => {
    const input = INPUTS.find((i) => i.id === $('input-type').value) || INPUTS[0];
    const outputType = $('goal-type').value;
    const plan = await callAndShow('pipeline_plan', { inputType: input.type, outputType });
    $('plan-hint').textContent = plan.ok ? 'planned: ' + plan.steps.join(' → ') : plan.error.message + ' — ' + plan.error.hint;
    const built = await callAndShow('pipeline_build', {
      steps: plan.ok ? plan.steps : ['office-text'],
      inputType: input.type,
      outputType,
      name: input.label + ' → ' + outputType,
      origin: 'human',
      rationale: plan.ok ? 'planned chain: ' + plan.steps.join(' → ') : 'no chain in the catalogue reaches ' + outputType + ' from ' + input.type + '; the legacy handler is a placeholder to edit.',
    });
    if (built.ok) await callAndShow('pipeline_score', { pipelineId: built.pipeline.id });
  }));

  $('btn-ask').addEventListener('click', handled(async () => {
    const goal = $('agent-goal').value || 'turn a pdf into a summary';
    await callAndShow('pipeline_propose', { goal });
  }));

  $('btn-bad').addEventListener('click', handled(() => callAndShow('pipeline_seed_bad', {})));

  $('btn-good').addEventListener('click', handled(async () => {
    const g = knownGoodProposal();
    const built = await callAndShow('pipeline_build', { steps: g.steps.map((s) => s.toolId), inputType: g.inputType, outputType: g.outputType, name: g.name, origin: 'seeded', selfScore: g.selfScore, rationale: g.rationale });
    if (built.ok) await callAndShow('pipeline_score', { pipelineId: built.pipeline.id });
  }));

  $('palette-filter').addEventListener('input', renderPalette);

  $('palette').addEventListener('click', handled(async (ev) => {
    const btn = ev.target.closest('[data-palette]');
    if (!btn) return;
    const toolId = btn.dataset.palette;
    if (store.pipelines.length) await callAndShow('pipeline_add_step', { toolId });
    else await callAndShow('pipeline_build', { steps: [toolId], origin: 'human', name: 'Hand-built' });
  }));

  $('canvas').addEventListener('click', handled(async (ev) => {
    const card = ev.target.closest('[data-pid]');
    if (!card) return;
    const pid = card.dataset.pid;
    const btn = ev.target.closest('[data-act]');
    select(pid);
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'remove') await callAndShow('pipeline_remove_step', { pipelineId: pid, position: Number(btn.dataset.i) });
    else if (act === 'delete') { deletePipeline(pid); logLine('dim', '✕ deleted ' + pid + ' (human)'); }
    else if (act === 'score') await callAndShow('pipeline_score', { pipelineId: pid });
    else if (act === 'validate') await callAndShow('pipeline_validate', { pipelineId: pid });
    else if (act === 'run') await callAndShow('pipeline_run', { pipelineId: pid, fixture: selectedFixture() });
  }));

  $('btn-oracle-inspect').addEventListener('click', handled(async () => {
    const r = await callAndShow('oracle_trap_list', { format: 'detailed' });
    $('oracle-out').textContent = JSON.stringify(r, null, 2);
    logLine('head', 'oracle catalogue: ' + (r.count || 0) + ' traps · ' + (r.oracle || r.from) + ' · bridged through ' + r.bridgedTo);
  }));

  $('btn-call').addEventListener('click', handled(async () => {
    const name = $('call-tool').value;
    let input = {};
    try { input = JSON.parse($('call-input').value || '{}'); } catch (e) { showCall(name, { error: 'input is not JSON: ' + String(e.message) }); return; }
    try { await callAndShow(name, input); } catch (e) { showCall(name, { error: String(e && e.message ? e.message : e) }); }
  }));

  $('invocations').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-n]');
    if (!tr) return;
    const entry = store.log.find((l) => String(l.n) === tr.dataset.n);
    if (entry) $('call-out').textContent = '#' + entry.n + ' ' + entry.name + ' (' + entry.ms + 'ms)\ninput: ' + entry.input + '\noutput: ' + entry.output;
  });

  $('btn-clear-history').addEventListener('click', () => {
    clearRuns();
    clearConsole();
    $('run-note').textContent = 'history cleared';
  });

  $('chk-delete').addEventListener('change', handled(async (ev) => {
    if (ev.target.checked) await armDelete();
    else disarmDelete();
    $('delete-note').textContent = deleteArmed() ? 'pipeline_delete is registered' : 'pipeline_delete is not registered';
  }));

  $('input-type').addEventListener('change', () => {
    const input = INPUTS.find((i) => i.id === $('input-type').value);
    if (input && store.fixtures.some((f) => f.name === input.fixture)) $('fixture-id').value = input.fixture;
  });

  // registered before the first registerTool so every change is counted
  window.addEventListener('mc-toolchange', () => {
    store.toolChanges += 1;
    renderToolList().catch((err) => reportError('toolchange', err));
  });
  bus.addEventListener('change', scheduleRender);
  window.addEventListener('error', (ev) => reportError('window', ev.error || ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError('unhandledrejection', ev.reason));
}

async function mountScorer() {
  const frame = $('scorer-frame');
  frame.src = IS_MULTI ? SCORER_ORIGIN + '/index.html' : './scorer/index.html';
  await window.MC.whenChild(frame, 12000);
}

async function seed() {
  await seedPipeline(knownBadProposal(), 'seeded');
  const good = await seedPipeline(knownGoodProposal(), 'seeded');
  select(store.pipelines[0].id);
  return good;
}

async function boot() {
  try {
    wireUi();
    buildFixtures();
    renderSelects();
    renderPalette();
    await registerTools();
    await mountScorer();
    await loadTrapCatalogue();
    await seed();
    await renderToolList();
    renderAll();
    const real = CATALOG.filter((t) => t.mode === 'real').length;
    logLine('head', 'studio ready · ' + CATALOG.length + ' transforms (' + real + ' REAL, ' + (CATALOG.length - real) + ' SIMULATED) · ' +
      store.oracle.traps.length + ' traps on the oracle origin ' + (IS_MULTI ? '(' + SCORER_ORIGIN + ')' : '(same-origin iframe, single-folder mode)'));
  } catch (err) {
    window.__bootError = String(err && err.stack ? err.stack : err);
    reportError('boot', err);
  }
  window.__recipe = { state: snapshot, log: () => store.log.slice(), errors: store.errors, SCORER_ORIGIN, IS_MULTI };
  window.MC.ready();
}

boot();
