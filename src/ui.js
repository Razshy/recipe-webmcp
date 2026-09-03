/* src/ui.js — every DOM write in the studio. Text goes through textContent, structure through
 * createElement: tool results, descriptions, agent-supplied names and oracle fields are untrusted
 * text and never reach an HTML sink. Renders are idempotent (state in, DOM out). */

import { CATALOG, BY_ID, INPUTS, GOALS } from './catalog.js';
import { validatePipeline } from './engine.js';
import { store } from './state.js';
import { SCORER_ORIGIN, IS_MULTI, SCORER_TOOLS, oracleTools } from './oracle.js';
import { sniffMagic, textEncode } from './bytes.js';

const $ = (id) => document.getElementById(id);
const LINE_LIMIT = 400;

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/* ---------------------------------------------------------------- console */

export function logLine(kind, text) {
  const lines = $('console-lines');
  const div = el('div', 'line ' + kind, text);
  lines.appendChild(div);
  while (lines.childElementCount > LINE_LIMIT) lines.removeChild(lines.firstChild);
  const box = $('console');
  box.scrollTop = box.scrollHeight;
  return div;
}

export function logArtifact(dataUrl, bytes) {
  const div = logLine('ok', '     artifact: ');
  const span = el('span', 'artifact');
  const a = el('a', '', bytes + 'B png');
  a.href = dataUrl; a.target = '_blank'; a.rel = 'noreferrer';
  const img = el('img');
  img.src = dataUrl; img.alt = 'pipeline png artifact'; img.width = 61; img.height = 46;
  span.append(a, img);
  div.appendChild(span);
}

export function clearConsole() {
  $('console-lines').textContent = '';
}

export function showCall(name, result) {
  const txt = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  $('call-out').textContent = '→ ' + name + '\n' + txt;
}

/* ------------------------------------------------------------- selects */

export function renderSelects() {
  const inp = $('input-type');
  const goal = $('goal-type');
  inp.textContent = '';
  goal.textContent = '';
  for (const i of INPUTS) {
    const o = el('option', '', i.label);
    o.value = i.id;
    inp.appendChild(o);
  }
  for (const g of GOALS) {
    const o = el('option', '', g.label);
    o.value = g.type;
    goal.appendChild(o);
  }
}

function paintFixtures() {
  const sel = $('fixture-id');
  const current = sel.value;
  sel.textContent = '';
  for (const f of store.fixtures) {
    const size = f.bytes ? f.bytes.length : (f.text ? textEncode(f.text).length : (f.files ? f.files.reduce((a, x) => a + x.bytes, 0) : 0));
    const magic = f.bytes ? ' · magic: ' + sniffMagic(f.bytes).magic : (f.kind === 'files' ? ' · ' + f.files.length + ' parts' : ' · text');
    const o = el('option', '', f.name + ' (' + (f.type || f.kind) + ', ' + size + 'B)' + magic);
    o.value = f.name;
    sel.appendChild(o);
  }
  if (store.fixtures.some((f) => f.name === current)) sel.value = current;
}

/* --------------------------------------------------------------- pills */

function setPill(id, text, cls) {
  const node = $(id);
  node.textContent = text;
  node.className = 'pill' + (cls ? ' ' + cls : '');
}

function paintPills() {
  const realCount = CATALOG.filter((t) => t.mode === 'real').length;
  setPill('pill-engine', 'WebMCP: ' + (window.MC.native ? 'native document.modelContext' : 'kit shim (spec-shaped)'), window.MC.native ? 'ok' : 'warn');
  setPill('pill-origin', IS_MULTI ? 'origins: multi (studio + oracle on separate ports)' : 'origins: single folder (oracle is a same-origin iframe)', IS_MULTI ? 'ok' : 'warn');
  setPill('pill-oracle', store.oracle.reachable
    ? 'oracle: ' + SCORER_TOOLS.length + ' tools via fromOrigins · ' + store.oracle.calls + ' scored'
    : 'oracle: not reachable', store.oracle.reachable ? 'ok' : 'bad');
  setPill('pill-real', 'REAL: ' + realCount + ' · SIMULATED: ' + (CATALOG.length - realCount), 'warn');
  setPill('pill-toolchange', 'toolchange ×' + store.toolChanges, '');
}

/* ------------------------------------------------------------- palette */

export function renderPalette() {
  const box = $('palette');
  const filter = $('palette-filter').value.toLowerCase();
  box.textContent = '';
  const rows = CATALOG.filter((t) => !filter || (t.id + ' ' + t.label + ' ' + t.mode + ' ' + t.in + ' ' + t.out).toLowerCase().includes(filter));
  $('palette-count').textContent = rows.length + '/' + CATALOG.length;
  for (const t of rows) {
    const b = el('button', 'pal-item ' + t.mode);
    b.type = 'button';
    b.dataset.palette = t.id;
    b.title = t.detail || t.engine;
    b.appendChild(el('span', 'pal-label', t.label));
    b.appendChild(el('span', 'badge ' + (t.mode === 'real' ? 'real' : 'sim'), t.mode === 'real' ? 'REAL' : 'SIMULATED'));
    if (t.traps && t.traps.length) b.appendChild(el('span', 'badge trap', t.traps.join(' ')));
    b.appendChild(el('span', 'pal-io', t.in + '→' + t.out));
    box.appendChild(b);
  }
}

/* -------------------------------------------------------------- canvas */

function starRow(score) {
  const wrap = el('div', 'stars' + (score.score < 100 ? ' dirty' : ''));
  const glyphs = el('span', 'glyphs');
  const stars = Number.isFinite(score.stars) ? score.stars : Math.round(score.score / 20);
  for (let i = 0; i < 5; i++) {
    const on = i + 1 <= stars;
    const half = !on && i + 0.5 <= stars;
    glyphs.appendChild(el('span', on ? 'on' : (half ? 'half' : 'off'), on ? '★' : (half ? '⯨' : '☆')));
  }
  wrap.append(glyphs, el('span', 'num', score.score), el('span', 'lbl', '/ 100'));
  return wrap;
}

function scoreCard(p) {
  const box = el('div', 'pcard-score');
  if (!p.lastScore) {
    box.classList.add('muted');
    box.textContent = 'not scored yet — the oracle is only consulted on demand.';
    return box;
  }
  const s = p.lastScore;
  if (s.hits && s.hits.length) {
    const ul = el('ul');
    for (const h of s.hits) {
      const li = el('li');
      li.appendChild(el('code', '', h.trapId));
      li.appendChild(document.createTextNode(' '));
      li.appendChild(el('strong', '', h.title || ''));
      li.appendChild(document.createTextNode(' (' + h.severity + ', −' + h.weight + ') '));
      li.appendChild(el('span', 'basis ' + h.basis, h.basis));
      li.appendChild(document.createTextNode(' — ' + (h.lesson || '')));
      ul.appendChild(li);
    }
    box.appendChild(ul);
  } else {
    box.appendChild(el('p', 'muted tight', 'no trap hits. The catalogue has nothing to say about this chain.'));
  }
  const ev = s.evidence || {};
  const measured = Object.keys(ev.measured || {});
  const claimed = ev.claimed || [];
  box.appendChild(el('p', 'mono evidence', 'evidence · measured by the oracle: ' + (measured.join(', ') || 'none') +
    (ev.artifactSeen ? ' (re-sniffed ' + ev.artifactSeen.bytes + 'B, magic ' + ev.artifactSeen.magic + ')' : ' (no artifact sent)') +
    ' · claimed by the studio: ' + (claimed.join(', ') || 'none')));
  box.appendChild(el('p', 'muted mono tiny', 'scored by ' + (s.oracle || 'scorer') + ' · ' + (s.via || '')));
  if (p.selfScore != null) {
    const gap = p.selfScore - s.score;
    const line = el('p', 'pcard-gap');
    line.appendChild(document.createTextNode('proposer self-score '));
    line.appendChild(el('b', '', p.selfScore));
    line.appendChild(document.createTextNode(' · oracle ' + s.score + ' · gap '));
    line.appendChild(el('span', gap > 0 ? 'gapnum' : '', (gap > 0 ? '+' : '') + gap));
    if (gap > 0) line.appendChild(document.createTextNode(' (the proposer rated its own chain too highly)'));
    box.appendChild(line);
  }
  return box;
}

function stepItem(p, s, i) {
  const def = BY_ID[s.toolId] || { label: '?' + s.toolId, mode: 'real', in: '?', out: '?', engine: 'unknown transform', traps: [] };
  const li = el('li', 'step');
  li.dataset.test = 'step-row';
  const row = el('div', 'step-row');
  row.appendChild(el('span', 'step-label', (i + 1) + '. ' + def.label));
  row.appendChild(el('span', 'badge ' + (def.mode === 'real' ? 'real' : 'sim'), def.mode === 'real' ? 'REAL' : 'SIMULATED'));
  if (s.params && Object.keys(s.params).length) row.appendChild(el('span', 'badge', JSON.stringify(s.params)));
  const rm = el('button', 'btn tiny', '✕');
  rm.type = 'button'; rm.dataset.act = 'remove'; rm.dataset.i = String(i); rm.title = 'remove step'; rm.setAttribute('aria-label', 'remove step ' + (i + 1));
  row.appendChild(rm);
  li.appendChild(row);
  li.appendChild(el('div', 'step-io', def.in + ' → ' + def.out + ' · ' + def.engine));
  for (const tid of def.traps || []) {
    const t = store.oracle.traps.find((x) => x.id === tid);
    if (!t) continue;
    const hit = p.lastScore && p.lastScore.hits ? p.lastScore.hits.find((h) => h.trapId === tid) : null;
    if (!hit && p.lastScore) continue; // scored, and this chain did not trigger it
    const box = el('div', 'step-trap');
    box.dataset.test = 'step-trap';
    box.appendChild(el('b', '', t.id + (hit ? ' −' + hit.weight + ' (' + hit.basis + ')' : ' (implicated)')));
    box.appendChild(document.createTextNode(' ' + t.lesson));
    li.appendChild(box);
  }
  const runRec = p.lastRun && p.lastRun.steps ? p.lastRun.steps[i] : null;
  if (runRec) {
    const keys = Object.keys(runRec.notes || {});
    li.appendChild(el('div', 'step-io run ' + (runRec.ok ? 'ok' : 'err'), 'run: ' + (runRec.ok ? 'ok' : 'FAILED') +
      (runRec.ok ? ' · ' + runRec.bytesIn + 'B → ' + runRec.bytesOut + 'B' : '') + ' · ' + runRec.ms + 'ms' +
      (runRec.magic ? ' · magic: ' + runRec.magic : '') + (runRec.error ? ' · ' + runRec.error : '') +
      (keys.length ? ' · observed: ' + keys.join(', ') : '')));
  }
  return li;
}

function actionButton(label, act, test, extraClass) {
  const b = el('button', 'btn tiny' + (extraClass ? ' ' + extraClass : ''), label);
  b.type = 'button';
  b.dataset.act = act;
  if (test) b.dataset.test = test;
  return b;
}

function pipelineCard(p) {
  const card = el('article', 'pcard' + (p.id === store.selected ? ' selected' : ''));
  card.dataset.test = 'pipeline-card';
  card.dataset.pid = p.id;
  const head = el('div', 'pcard-head');
  const titles = el('div');
  titles.appendChild(el('h3', 'pcard-title', p.name));
  titles.appendChild(el('div', 'pcard-id mono', p.id + ' · proposed by ' + p.origin));
  head.appendChild(titles);
  if (p.lastScore) head.appendChild(starRow(p.lastScore));
  else { const u = el('div', 'stars'); u.appendChild(el('span', 'lbl', 'unscored')); head.appendChild(u); }
  card.appendChild(head);
  const validation = validatePipeline(p);
  const io = el('div', 'pcard-io');
  io.appendChild(document.createTextNode('input '));
  io.appendChild(el('b', '', p.inputType));
  io.appendChild(document.createTextNode(' → goal '));
  io.appendChild(el('b', '', p.outputType));
  io.appendChild(el('br'));
  io.appendChild(document.createTextNode('chain: ' + validation.chain.join(' → ')));
  card.appendChild(io);
  if (p.agentRationale) card.appendChild(el('div', 'pcard-io rationale', p.agentRationale));
  if (validation.errors.length) {
    const box = el('div', 'step-trap');
    validation.errors.forEach((e, i) => {
      if (i) box.appendChild(el('br'));
      box.appendChild(document.createTextNode(e.message + (e.fix ? ' — fix: ' + e.fix : '')));
    });
    card.appendChild(box);
  }
  const ul = el('ul', 'steps');
  if (p.steps.length) p.steps.forEach((s, i) => ul.appendChild(stepItem(p, s, i)));
  else ul.appendChild(el('li', 'step muted', 'empty recipe — add transforms from the palette'));
  card.appendChild(ul);
  const actions = el('div', 'pcard-actions');
  actions.append(
    actionButton('Run on fixture', 'run', 'btn-run', 'primary'),
    actionButton('Score via oracle', 'score', 'btn-score'),
    actionButton('Validate', 'validate', 'btn-validate'),
    actionButton('Delete', 'delete', 'btn-delete'),
  );
  card.appendChild(actions);
  card.appendChild(scoreCard(p));
  return card;
}

function renderCanvas() {
  const canvas = $('canvas');
  const note = $('canvas-note');
  canvas.textContent = '';
  if (!store.pipelines.length) {
    canvas.appendChild(el('div', 'empty-canvas', 'No recipes yet. Pick an input and a goal, or press Ask the agent / Propose the bad one.'));
    note.textContent = 'no recipes yet';
    return;
  }
  note.textContent = store.pipelines.length + ' recipe' + (store.pipelines.length > 1 ? 's' : '') + ' · click a card to select it, click a palette transform to append';
  for (const p of store.pipelines) canvas.appendChild(pipelineCard(p));
}

/* -------------------------------------------------------- agent surface */

function paramLines(schema) {
  const props = schema && schema.properties ? schema.properties : {};
  const required = new Set(schema && schema.required ? schema.required : []);
  return Object.entries(props).map(([k, v]) => k + (required.has(k) ? '*' : '') + ': ' + (v.type || '?') + (v.enum ? ' ∈ {' + v.enum.join('|') + '}' : '') + (v.description ? ' — ' + v.description : ''));
}

export async function renderToolList() {
  let tools = [];
  try { tools = await window.mc.getTools({ fromOrigins: [SCORER_ORIGIN] }); } catch (e) { tools = []; }
  await oracleTools();
  const list = $('agent-tools');
  const sel = $('call-tool');
  const current = sel.value;
  list.textContent = '';
  sel.textContent = '';
  $('tool-count').textContent = String(tools.length);
  for (const t of tools) {
    const foreign = t.origin !== window.location.origin;
    const li = el('li');
    const head = el('div', 'tool-head');
    head.appendChild(el('code', 'tool-name', t.name));
    head.appendChild(el('span', 'x ' + (foreign ? 'foreign' : 'local'), foreign ? 'oracle origin' : 'this page'));
    if (t.annotations && t.annotations.readOnlyHint) head.appendChild(el('span', 'x ro', 'read-only'));
    if (t.annotations && t.annotations.untrustedContentHint) head.appendChild(el('span', 'x', 'untrusted content'));
    li.appendChild(head);
    if (t.title) li.appendChild(el('div', 'tool-title', t.title));
    li.appendChild(el('div', 'tool-desc', t.description));
    const params = paramLines(t.inputSchema);
    if (params.length) {
      const ul = el('ul', 'tool-params');
      for (const line of params) ul.appendChild(el('li', '', line));
      li.appendChild(ul);
    }
    list.appendChild(li);
    const o = el('option', '', t.name + (foreign ? ' (oracle origin)' : ''));
    o.value = t.name;
    sel.appendChild(o);
  }
  if (tools.some((t) => t.name === current)) sel.value = current;
  $('surface-note').textContent = 'ChatGPT\'s browser lists the ' + tools.filter((t) => t.origin === window.location.origin).length +
    ' top-level tools only; the ' + tools.filter((t) => t.origin !== window.location.origin).length +
    ' oracle-origin tools are reached there through the oracle_* bridges. Chrome with the WebMCP flag sees all of them.';
  paintPills();
}

function renderInvocations() {
  const body = $('invocations');
  body.textContent = '';
  $('invocation-count').textContent = String(store.log.length);
  for (const entry of store.log.slice(0, 40)) {
    const tr = el('tr', entry.ok ? 'ok' : 'err');
    tr.dataset.n = String(entry.n);
    tr.tabIndex = 0;
    tr.appendChild(el('td', 'mono', entry.n));
    tr.appendChild(el('td', 'mono', entry.name));
    tr.appendChild(el('td', '', entry.ok ? 'ok' : 'error'));
    tr.appendChild(el('td', 'mono', entry.ms + 'ms'));
    tr.appendChild(el('td', 'mono clip', entry.input.length > 90 ? entry.input.slice(0, 90) + '…' : entry.input));
    tr.appendChild(el('td', 'mono clip', entry.output.length > 140 ? entry.output.slice(0, 140) + '…' : entry.output));
    body.appendChild(tr);
  }
}

/* ------------------------------------------------------------ scheduler */

let pending = false;
const settled = [];

export function renderAll() {
  renderCanvas();
  renderPalette();
  renderInvocations();
  paintFixtures();
  paintPills();
}

export function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderAll();
    while (settled.length) settled.pop()();
  });
}

/** Resolves once the canvas actually shows the state a tool just changed.
 *  Tools await this before returning, so a tool never reports a count or a
 *  selection the human cannot yet see. Falls back to a timer in a hidden tab,
 *  where requestAnimationFrame does not run. */
export function renderSettled() {
  if (!pending) return Promise.resolve();
  return new Promise((resolve) => {
    settled.push(resolve);
    setTimeout(() => {
      const i = settled.indexOf(resolve);
      if (i !== -1) { settled.splice(i, 1); resolve(); }
    }, 1000);
  });
}
