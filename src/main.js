/* src/main.js — the studio: store, canvas UI, fixtures, and every agent tool.
 * Two rules hold this file together: (1) every action the human can take is also a registered
 * tool, so the "Simulate agent" panel and the Playwright tests exercise the same code path the
 * user clicks; (2) nothing claims a result it did not produce — REAL steps execute here,
 * SIMULATED steps announce themselves in the badge, the tool description and the run console. */

import { CATALOG, BY_ID, GOALS, INPUTS } from './catalog.js';
import { validatePipeline, runPipeline, scoreLocally } from './engine.js';
import { propose, planChain } from './proposer.js';
import { TRAPS, SEVERITY_WEIGHT, TRAP_ENGINE } from './traps.js';
import { textToDocx, csvToXlsx } from './office.js';
import { writePdf } from './pdf.js';
import { writePdfRaw } from './pdf-fixtures.js';
import { mdToHtml } from './markdown.js';
import { writeZip } from './zip.js';
import { bytesFromB64, textEncode, sniffMagic } from './bytes.js';

const SCORER_ORIGIN = window.MC.origin('scorer');
const IS_MULTI = window.MC.isMulti;
const SCORER_TOOLS = ['score_pipeline', 'trap_list'];
const SCORER_DECOY = 'warm_cache';

/* ------------------------------------------------------------------ store */

const store = {
  pipelines: [],
  runs: [],
  fixtures: [],
  seq: 1,
  selected: null,
  scorerVisible: [],
  scorerReachable: false,
  scorerCalls: 0,
};

function newPipeline(fields) {
  const p = Object.assign({
    id: 'p' + (store.seq++),
    name: 'Recipe ' + (store.seq - 1),
    inputType: 'txt',
    outputType: 'txt',
    steps: [],
    origin: 'human',
    agentClaim: null,
    agentRationale: null,
    selfScore: null,
    lastScore: null,
    lastRun: null,
    createdAt: Date.now(),
  }, fields);
  store.pipelines.push(p);
  store.selected = p.id;
  return p;
}
const byId = (id) => store.pipelines.find((p) => p.id === id) || null;
function pick() { return byId(store.selected) || store.pipelines[store.pipelines.length - 1] || null; }
function fixtureByName(name) { return store.fixtures.find((f) => f.name === name) || null; }

function defaultFixtureFor(type) {
  const want = { pdf: 'pdf-doc', docx: 'docx-memo', xlsx: 'xlsx-sales', png: 'png-scan', md: 'md-notes', html: 'html-notes', csv: 'csv-sales', txt: 'txt-plain', doc: 'doc-legacy', scan: 'png-scan', zip: 'zip-parts', files: 'zip-parts' }[type];
  return fixtureByName(want) || store.fixtures[0] || null;
}

/* ------------------------------------------------------------- fixtures */

function pngBytes(w, h, painter) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  painter(ctx, w, h);
  return bytesFromB64(canvas.toDataURL('image/png').split(',')[1]);
}

function buildFixtures() {
  const memoText = [
    'Field notes from the document pipeline review',
    '',
    'Reference: SENTINEL-ZIP-42. This string exists only inside word/document.xml,',
    'so recovering it proves the zip was actually opened, inflated and parsed.',
    '',
    'Findings:',
    '- pandoc wrote a package the image did not contain',
    '- two converters exited 0 while writing nothing at all',
    '- the quality flag was accepted, echoed, and ignored for every value',
  ].join('\n');

  const csv = [
    'region,quarter,units,unit_price,net',
    'north,Q1,120,9.5,1140',
    'south,Q1,80,12.25,980',
    'east,Q2,45,7,315',
    'west,Q2,210,3.4,714',
  ].join('\r\n') + '\r\n';

  const md = [
    '# Pipeline retro',
    '',
    'What the **48 hour** audit actually produced:',
    '',
    '- exit 0 with no output file',
    '- a quality flag nobody read',
    '- [the opener that never closed](https://example.test/xdg-open)',
    '',
    '## Follow up',
    '',
    'Validate magic bytes after every convert.',
    '',
    '```',
    'pipeline = input -> steps -> output',
    '```',
  ].join('\n');

  const pngScan = pngBytes(120, 90, (ctx, w, h) => {
    ctx.fillStyle = '#241f1a';
    ctx.fillRect(10, 12, w - 20, 5);
    ctx.fillRect(10, 26, w - 44, 3);
    ctx.fillRect(10, 34, w - 30, 3);
    ctx.fillRect(10, 42, w - 52, 3);
    ctx.strokeStyle = '#241f1a';
    ctx.strokeRect(10, 54, w - 20, 26);
    ctx.beginPath(); ctx.moveTo(10, 66); ctx.lineTo(w - 10, 66); ctx.moveTo(50, 54); ctx.lineTo(50, 80); ctx.stroke();
  });

  const docx = textToDocx(memoText);
  const memoHtml = mdToHtml(md);
  const pdf = writePdf(memoText, { rects: [{ x: 54, y: 60, w: 18, h: 18 }] });
  const pdfSentinel = writePdf('Round-trip probe SENTINEL-PDF-7 lives in a Tj operator and must come back out.', {
    rects: [{ x: 420, y: 700, w: 30, h: 30 }],
  });
  const pdfOffcanvas = writePdfRaw('BT /F1 10 Tf 4800 4600 Td (HIDDEN-STRING-99 was never painted) Tj ET');
  const xlsx = csvToXlsx(csv);
  const zip = writeZip([
    { name: 'notes.md', data: textEncode('# inside a zip\n\nsecond part\n') },
    { name: 'data.csv', data: textEncode('a,b\n1,2\n') },
  ]);

  store.fixtures = [
    { name: 'docx-memo', type: 'docx', bytes: docx.bytes, note: 'real OOXML package: our writer, store-method zip, sentinel SENTINEL-ZIP-42 inside word/document.xml' },
    { name: 'pdf-doc', type: 'pdf', bytes: pdf, note: 'minimal single-font PDF (Tj operators) plus one painted rect' },
    { name: 'pdf-sentinel', type: 'pdf', bytes: pdfSentinel, note: 'round-trip probe carrying SENTINEL-PDF-7' },
    { name: 'pdf-offcanvas', type: 'pdf', bytes: pdfOffcanvas, note: 'the ink paradox: a string at 4800,4600 — readable, never painted' },
    { name: 'png-scan', type: 'png', bytes: pngScan, note: '120x90 synthetic scan: bars and a ruled table box, no text layer at all' },
    { name: 'xlsx-sales', type: 'xlsx', bytes: xlsx.bytes, note: 'real xlsx package: sheet1 with inline strings and numeric cells' },
    { name: 'zip-packed', type: 'zip', bytes: zip.bytes, note: 'store-method zip written by this app — hand it to zip-unpack' },
    { name: 'zip-parts', kind: 'files', files: [
      { name: 'notes.md', data: textEncode('# inside a zip\n\nsecond part\n'), bytes: 25 },
      { name: 'data.csv', data: textEncode('a,b\n1,2\n'), bytes: 8 },
    ], note: 'two parts awaiting a store-method pack' },
    { name: 'txt-plain', type: 'txt', text: memoText, note: 'the memo as plain text' },
    { name: 'txt-sentinel', type: 'txt', text: 'Round-trip probe SENTINEL-PDF-7 lives in a Tj operator and must come back out.\n', note: 'input side of the pdf round trip' },
    { name: 'md-notes', type: 'md', text: md, note: 'markdown with headings, lists, a link and a fence' },
    { name: 'html-notes', type: 'html', text: memoHtml, note: 'the markdown fixture converted to html by the app’s own converter' },
    { name: 'csv-sales', type: 'csv', text: csv, note: 'five-row sales table, unquoted numerics' },
    { name: 'doc-legacy', type: 'doc', bytes: docx.bytes, note: 'a .docx renamed to .doc — extension dispatch takes the wrong branch' },
    { name: 'png-bytes-named-pdf', type: 'pdf', bytes: pngScan, note: 'PNG bytes wearing a .pdf name; sniff it before trusting the label' },
  ];
  paintFixtures();
}

function paintFixtures() {
  const sel = document.getElementById('fixture-id');
  sel.innerHTML = '';
  for (const f of store.fixtures) {
    const o = document.createElement('option');
    const size = f.bytes ? f.bytes.length : (f.text ? textEncode(f.text).length : (f.files ? 33 : 0));
    const magic = f.bytes ? ' · magic: ' + sniffMagic(f.bytes).magic : (f.kind === 'files' ? ' · 2 parts' : ' · text');
    o.value = f.name;
    o.textContent = f.name + ' (' + (f.type || f.kind) + ', ' + size + 'B)' + magic;
    sel.appendChild(o);
  }
}

/* ------------------------------------------------------- scorer (oracle) */

async function scorerTools(force) {
  if (store.scorerVisible.length && !force) return store.scorerVisible;
  const tools = await window.mc.getTools({ fromOrigins: [SCORER_ORIGIN] });
  let visible = tools.filter((t) => SCORER_TOOLS.includes(t.name)).map((t) => t.name);
  if (!visible.length && !IS_MULTI) {
    // static-host fallback: the "oracle" is a same-origin iframe, so its registry is readable
    const frame = document.getElementById('scorer-frame');
    const reg = frame && frame.contentWindow && frame.contentWindow.__mcRegistry;
    if (reg) visible = SCORER_TOOLS.filter((n) => reg.has(n));
  }
  store.scorerVisible = visible;
  store.scorerReachable = visible.length > 0;
  return store.scorerVisible;
}

async function callScorerTool(name, input) {
  await scorerTools(true);
  let raw = null;
  try {
    raw = await window.mc.executeTool(name, input);
  } catch (err) {
    raw = null;
  }
  if (raw == null) {
    // single-origin static-host fallback: reach the frame's own registry directly
    const frame = document.getElementById('scorer-frame');
    const reg = frame && frame.contentWindow && frame.contentWindow.__mcRegistry;
    const rec = reg && reg.get(name);
    if (!rec) throw new Error('scorer tool unreachable: ' + name);
    const r = await rec.def.execute(input, {});
    raw = typeof r === 'string' ? r : JSON.stringify(r);
  }
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  store.scorerCalls++;
  paintPills();
  return parsed;
}

async function scoreViaOracle(pipeline, notes, opts = {}) {
  const steps = (pipeline.steps || []).map((s) => ({
    toolId: s.toolId,
    params: s.params || {},
    in: BY_ID[s.toolId] ? BY_ID[s.toolId].in : null,
    out: BY_ID[s.toolId] ? BY_ID[s.toolId].out : null,
  }));
  try {
    const r = await callScorerTool('score_pipeline', {
      steps,
      notes: notes || {},
      inputType: pipeline.inputType,
      outputType: pipeline.outputType,
      mode: opts.mode || 'clamp',
    });
    return Object.assign({ via: IS_MULTI ? 'fromOrigins(cross-origin)' : 'same-origin fallback' }, r);
  } catch (err) {
    const local = scoreLocally(pipeline, notes || {});
    return {
      ok: true, score: local.score, penalty: local.penalty, stars: local.stars, hits: local.hits,
      engine: TRAP_ENGINE, oracle: 'local-fallback', via: 'in-page mirror (oracle unreachable: ' + String(err && err.message ? err.message : err) + ')',
    };
  }
}

/* ------------------------------------------------------------- pills/status */

function paintPills() {
  const realCount = CATALOG.filter((t) => t.mode === 'real').length;
  const simCount = CATALOG.length - realCount;
  setPill('pill-engine', 'webmcp: ' + (window.__mcNative ? 'native document.modelContext' : 'kit shim'), 'ok');
  setPill('pill-origin', IS_MULTI ? 'multi-origin (' + Object.keys(window.__ORIGINS).join(', ') + ')' : 'single-origin fallback', IS_MULTI ? 'ok' : 'warn');
  setPill('pill-tools', 'tools: ' + document.getElementById('tool-count').textContent + ' visible', 'ok');
  setPill('pill-oracle', store.scorerReachable
    ? 'oracle: ' + SCORER_TOOLS.length + ' tools via fromOrigins · ' + store.scorerCalls + ' scored'
    : 'oracle: not reachable', store.scorerReachable ? 'ok' : 'warn');
  setPill('pill-real', 'REAL: ' + realCount + ' · SIMULATED: ' + simCount, 'warn');
  document.getElementById('engine-stamp').textContent = TRAP_ENGINE;
}
function setPill(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'pill' + (cls ? ' ' + cls : '');
}

/* ------------------------------------------------------------- rendering */

function trapIdsForStep(step) {
  const def = BY_ID[step.toolId];
  if (!def || !def.traps) return [];
  return def.traps.filter((id) => TRAPS.some((t) => t.id === id));
}

function starRow(score) {
  const full = Math.max(0, Math.min(5, Math.round((score / 100) * 5)));
  const dirty = score < 100;
  let glyphs = '';
  for (let i = 0; i < 5; i++) glyphs += '<span class="' + (i < full ? 'on' : 'off') + '">' + (i < full ? '★' : '☆') + '</span>';
  return '<div class="stars' + (dirty ? ' dirty' : '') + '"><span class="glyphs">' + glyphs + '</span>' +
    '<span class="num">' + score + '</span><span class="lbl">/ 100</span></div>';
}

function pipelineScoreCard(p) {
  if (!p.lastScore) return '<div class="pcard-score muted">not scored yet — the oracle is only consulted on demand.</div>';
  const s = p.lastScore;
  const hits = (s.hits || []).length
    ? '<ul>' + s.hits.map((h) => '<li><code>' + h.trapId + '</code> <strong>' + esc(h.title || '') + '</strong> (' + h.severity + ', −' + h.weight + ') — ' + esc(h.lesson) + '</li>').join('') + '</ul>'
    : '<p class="muted" style="margin:6px 0 0">no trap hits. The catalogue has nothing to say about this chain.</p>';
  const runtime = (p.lastScore.notes && Object.keys(p.lastScore.notes).length)
    ? '<p class="mono" style="font-size:11px;margin:6px 0 0;color:#7a1d22">runtime evidence sent to the oracle: ' + esc(JSON.stringify(p.lastScore.notes)) + '</p>'
    : '';
  return '<div class="pcard-score">' + hits + runtime +
    '<p class="muted mono" style="font-size:10.5px;margin:7px 0 0">scored by ' + esc(s.oracle || 'scorer') + ' · ' + esc(s.via || '') + '</p>' +
    gapLine(p) + '</div>';
}

function gapLine(p) {
  if (p.selfScore == null || !p.lastScore) return '';
  const gap = p.selfScore - p.lastScore.score;
  if (gap === 0) return '<p class="pcard-gap">agent self-score ' + p.selfScore + ' · oracle ' + p.lastScore.score + ' · gap 0</p>';
  return '<p class="pcard-gap">agent self-score <b>' + p.selfScore + '</b> · oracle ' + p.lastScore.score +
    ' · gap <span class="gapnum">' + (gap > 0 ? '+' : '') + gap + '</span>' +
    (gap > 0 ? ' (the proposer rated its own chain too highly)' : '') + '</p>';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderCanvas() {
  const canvas = document.getElementById('canvas');
  const note = document.getElementById('canvas-note');
  canvas.innerHTML = '';
  if (!store.pipelines.length) {
    canvas.innerHTML = '<div class="empty-canvas">No recipes yet. Pick an input and a goal, or press ' +
      '<strong>Ask the agent</strong> / <strong>Propose the bad one</strong>.</div>';
    note.textContent = 'no recipes yet';
    return;
  }
  note.textContent = store.pipelines.length + ' recipe' + (store.pipelines.length > 1 ? 's' : '') +
    ' · click a card to select it, click a palette transform to append';
  for (const p of store.pipelines) {
    const el = document.createElement('article');
    el.className = 'pcard' + (p.id === store.selected ? ' selected' : '');
    el.setAttribute('data-test', 'pipeline-card');
    el.setAttribute('data-pid', p.id);
    const validation = validatePipeline(p);
    const chain = validation.chain.join(' → ');
    const steps = p.steps.map((s, i) => {
      const def = BY_ID[s.toolId] || { label: '?' + s.toolId, mode: 'real', in: '?', out: '?' };
      const hitFor = (tid) => (p.lastScore && p.lastScore.hits ? p.lastScore.hits.find((h) => h.trapId === tid) : null);
      const ids = trapIdsForStep(s);
      const trapText = ids.map((tid) => {
        const t = TRAPS.find((x) => x.id === tid);
        if (!t) return '';
        const hit = hitFor(tid);
        if (!hit && p.lastScore) return ''; // scored, and this chain did not trigger it
        return '<div class="step-trap" data-test="step-trap"><b>' + t.id + (hit ? ' −' + hit.weight : '') + '</b> ' + esc(t.lesson) + '</div>';
      }).join('');
      const runRec = p.lastRun && p.lastRun.steps ? p.lastRun.steps[i] : null;
      const runLine = runRec
        ? '<div class="step-io ' + (runRec.ok ? 'ok' : 'err') + '">run: ' + (runRec.ok ? 'ok' : 'FAILED') +
          ' · ' + runRec.bytesIn + 'B → ' + runRec.bytesOut + 'B · ' + runRec.ms + 'ms' +
          (runRec.magic ? ' · magic: ' + esc(runRec.magic) : '') +
          (runRec.error ? ' · ' + esc(runRec.error) : '') + '</div>'
        : '';
      return '<li class="step" data-test="step-row">' +
        '<div class="step-row"><span class="step-label">' + (i + 1) + '. ' + esc(def.label) + '</span>' +
        '<span class="badge ' + (def.mode === 'real' ? 'real' : 'sim') + '">' + (def.mode === 'real' ? 'REAL' : 'SIMULATED') + '</span>' +
        (s.params && Object.keys(s.params).length ? '<span class="badge">' + esc(JSON.stringify(s.params)) + '</span>' : '') +
        '<button class="btn tiny" data-act="remove" data-i="' + i + '" title="remove step">✕</button></div>' +
        '<div class="step-io">' + esc(def.in) + ' → ' + esc(def.out) + ' · ' + esc(def.engine) + '</div>' +
        trapText + runLine + '</li>';
    }).join('');
    el.innerHTML =
      '<div class="pcard-head"><div><h3 class="pcard-title">' + esc(p.name) + '</h3>' +
      '<div class="pcard-id mono">' + esc(p.id) + ' · proposed by ' + esc(p.origin) + '</div></div>' +
      (p.lastScore ? starRow(p.lastScore.score) : '<div class="stars"><span class="lbl">unscored</span></div>') +
      '</div>' +
      '<div class="pcard-io">input <b>' + esc(p.inputType) + '</b> → goal <b>' + esc(p.outputType) + '</b><br>chain: ' + esc(chain) + '</div>' +
      (p.agentRationale ? '<div class="pcard-io" style="font-style:italic">' + esc(p.agentRationale) + '</div>' : '') +
      (validation.errors.length ? '<div class="step-trap">' + validation.errors.map((e) => esc(e.message) + (e.fix ? ' — fix: ' + esc(e.fix) : '')).join('<br>') + '</div>' : '') +
      '<ul class="steps">' + (steps || '<li class="step muted">empty recipe — add transforms from the palette</li>') + '</ul>' +
      '<div class="pcard-actions">' +
      '<button class="btn tiny primary" data-act="run" data-test="btn-run">Run on fixture</button>' +
      '<button class="btn tiny" data-act="score" data-test="btn-score">Score via oracle</button>' +
      '<button class="btn tiny" data-act="validate">Validate</button>' +
      '<button class="btn tiny" data-act="delete">Delete</button></div>' +
      pipelineScoreCard(p);
    el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) { store.selected = p.id; renderCanvas(); return; }
      const act = btn.getAttribute('data-act');
      store.selected = p.id;
      if (act === 'remove') { p.steps.splice(Number(btn.getAttribute('data-i')), 1); renderAll(); }
      else if (act === 'delete') { window.__agent.call('pipeline_delete', { id: p.id }); }
      else if (act === 'score') { window.__agent.call('pipeline_score', { pipelineId: p.id }).then(renderCanvas); }
      else if (act === 'validate') { window.__agent.call('pipeline_validate', { pipelineId: p.id }).then((r) => logLine('dim', 'validate ' + p.id + ' → ' + r)); }
      else if (act === 'run') { window.__agent.call('pipeline_run', { pipelineId: p.id, fixture: document.getElementById('fixture-id').value }).then(renderCanvas); }
    });
    canvas.appendChild(el);
  }
}

function renderPalette() {
  const box = document.getElementById('palette');
  const filter = document.getElementById('palette-filter').value.toLowerCase();
  const p = pick();
  box.innerHTML = '';
  const rows = CATALOG.filter((t) => !filter || (t.id + ' ' + t.label + ' ' + t.mode + ' ' + t.in + ' ' + t.out).toLowerCase().includes(filter));
  document.getElementById('palette-count').textContent = rows.length + '/' + CATALOG.length;
  for (const t of rows) {
    const b = document.createElement('button');
    b.className = 'pal-item ' + t.mode;
    b.type = 'button';
    b.setAttribute('data-palette', t.id);
    b.title = t.detail || t.engine;
    b.innerHTML = '<span class="pal-label">' + esc(t.label) + '</span>' +
      '<span class="badge ' + (t.mode === 'real' ? 'real' : 'sim') + '">' + (t.mode === 'real' ? 'REAL' : 'SIM') + '</span>' +
      (t.traps && t.traps.length ? '<span class="badge trap">' + t.traps.join(' ') + '</span>' : '') +
      '<span class="pal-io">' + esc(t.in) + '→' + esc(t.out) + '</span>';
    b.addEventListener('click', () => {
      const target = pick() || newPipeline({
        name: 'Hand-built ' + (p ? '' : ''),
        inputType: t.in,
        outputType: t.out,
        origin: 'human',
      });
      window.__agent.call('pipeline_add_step', { pipelineId: target.id, toolId: t.id }).then(renderAll);
    });
    box.appendChild(b);
  }
}

function renderSelects() {
  const inp = document.getElementById('input-type');
  const goal = document.getElementById('goal-type');
  inp.innerHTML = '';
  goal.innerHTML = '';
  for (const i of INPUTS) {
    const o = document.createElement('option');
    o.value = i.type; o.textContent = i.label + (i.type === 'scan' ? ' — unknown to the catalogue' : '');
    inp.appendChild(o);
  }
  for (const g of GOALS) {
    const o = document.createElement('option');
    o.value = g.type; o.textContent = g.label;
    goal.appendChild(o);
  }
  const quick = document.getElementById('agent-quick');
  quick.innerHTML = '';
  const btn = (label, fn, test) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.textContent = label;
    if (test) b.setAttribute('data-test', test);
    b.addEventListener('click', fn);
    quick.appendChild(b);
  };
  btn('catalog_list', () => window.__agent.call('catalog_list', {}).then((r) => showCall('catalog_list', r)), 'quick-catalog');
  btn('fixture_list', () => window.__agent.call('fixture_list', {}).then((r) => showCall('fixture_list', r)), 'quick-fixtures');
  btn('validate selected', () => {
    const p = pick();
    if (!p) return showCall('pipeline_validate', { error: 'no pipeline selected' });
    window.__agent.call('pipeline_validate', { pipelineId: p.id }).then((r) => { showCall('pipeline_validate', r); renderCanvas(); });
  }, 'quick-validate');
  btn('score selected', () => {
    const p = pick();
    if (!p) return showCall('pipeline_score', { error: 'no pipeline selected' });
    window.__agent.call('pipeline_score', { pipelineId: p.id }).then((r) => { showCall('pipeline_score', r); renderCanvas(); });
  }, 'quick-score');
  btn('run selected', () => {
    const p = pick();
    if (!p) return showCall('pipeline_run', { error: 'no pipeline selected' });
    window.__agent.call('pipeline_run', { pipelineId: p.id, fixture: document.getElementById('fixture-id').value }).then((r) => { showCall('pipeline_run', r); renderCanvas(); });
  }, 'quick-run');
  btn('run_history', () => window.__agent.call('run_history', {}).then((r) => showCall('run_history', r)), 'quick-history');
  btn('step_explain', () => {
    const p = pick();
    const toolId = p && p.steps[0] ? p.steps[0].toolId : 'ocr';
    window.__agent.call('step_explain', { toolId }).then((r) => showCall('step_explain', r));
  }, 'quick-explain');
}

async function renderToolList() {
  const tools = await window.__agent.tools();
  const scorer = await scorerTools(true);
  const list = document.getElementById('agent-tools');
  const sel = document.getElementById('call-tool');
  const names = tools.map((t) => t.name);
  document.getElementById('tool-count').textContent = String(names.length + scorer.length);
  list.innerHTML = '';
  const all = [
    ...names.map((n) => ({ n, foreign: false })),
    ...scorer.map((n) => ({ n, foreign: true })),
  ];
  for (const t of all) {
    const li = document.createElement('li');
    li.innerHTML = '<span>' + esc(t.n) + '</span>' + (t.foreign ? '<span class="x">oracle origin</span>' : '');
    list.appendChild(li);
  }
  const current = sel.value;
  sel.innerHTML = '';
  for (const t of all) {
    const o = document.createElement('option');
    o.value = t.n; o.textContent = t.n;
    sel.appendChild(o);
  }
  if (names.includes(current) || scorer.includes(current)) sel.value = current;
  paintPills();
}

function renderAll() {
  renderCanvas();
  renderPalette();
  renderToolList();
}

/* ------------------------------------------------------------- console */

const LINE_LIMIT = 400;
function logLine(kind, text) {
  const lines = document.getElementById('console-lines');
  const div = document.createElement('div');
  div.className = 'line ' + kind;
  div.innerHTML = text;
  lines.appendChild(div);
  while (lines.childElementCount > LINE_LIMIT) lines.removeChild(lines.firstChild);
  const box = document.getElementById('console');
  box.scrollTop = box.scrollHeight;
  return div;
}
function showCall(name, result) {
  const txt = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  document.getElementById('call-out').textContent = '→ ' + name + '\n' + txt;
  logLine('dim', '<span class="k">' + esc(name) + '</span> ' + esc(txt.length > 600 ? txt.slice(0, 600) + '…' : txt));
}

/* ------------------------------------------------------------- tools */

const stepArraySchema = {
  type: 'array',
  description: 'Ordered transforms. Each item is a toolId string or {toolId, params?}.',
  items: {
    oneOf: [
      { type: 'string' },
      { type: 'object', properties: { toolId: { type: 'string' }, params: { type: 'object' } }, required: ['toolId'] },
    ],
  },
};
function normaliseSteps(arr) {
  return (arr || []).map((s) => (typeof s === 'string' ? { toolId: s } : { toolId: s.toolId, params: s.params || {} }));
}

const controllers = { probe: new AbortController() };

async function registerTools() {
  await window.mc.registerTool({
    name: 'catalog_list',
    title: 'Transform catalogue',
    description: 'List every transform the studio can put in a pipeline, each tagged mode REAL (executes in this tab now) or SIMULATED (deterministic stand-in), with the traps it is known to trigger. Returns {count, real, simulated, transforms:[...], trapEngine}.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['real', 'simulated', 'all'], description: 'Filter by engine honesty. Default all.' },
        io: { type: 'string', description: 'Only transforms touching this type (as input or output).' },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      let rows = CATALOG.slice();
      if (input && input.mode && input.mode !== 'all') rows = rows.filter((t) => t.mode === input.mode);
      if (input && input.io) rows = rows.filter((t) => t.in === input.io || t.out === input.io);
      return {
        ok: true,
        count: rows.length,
        real: rows.filter((t) => t.mode === 'real').length,
        simulated: rows.filter((t) => t.mode === 'simulated').length,
        transforms: rows.map((t) => ({ id: t.id, label: t.label, in: t.in, out: t.out, mode: t.mode, engine: t.engine, traps: t.traps || [] })),
        trapEngine: TRAP_ENGINE,
      };
    },
  });

  await window.mc.registerTool({
    name: 'pipeline_build',
    title: 'Build a pipeline',
    description: 'Create a pipeline from an ordered step list. Input {steps:[toolId|{toolId,params}], inputType?, outputType?, name?, origin?, selfScore?, rationale?}. Returns the pipeline plus its validation chain. Unknown toolIds are kept and reported as errors by pipeline_validate.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: stepArraySchema,
        inputType: { type: 'string', description: 'Input type; defaults to the first step\'s input.' },
        outputType: { type: 'string', description: 'Goal type; defaults to the last step\'s output.' },
        name: { type: 'string' },
        origin: { type: 'string', description: 'Who proposed it: human | agent | seeded.' },
        selfScore: { type: 'number', description: 'Proposer confidence, for the self-score vs oracle gap.' },
        rationale: { type: 'string' },
      },
      required: ['steps'],
    },
    execute: async (input) => {
      const steps = normaliseSteps(input.steps);
      const first = BY_ID[steps[0] ? steps[0].toolId : ''];
      const last = BY_ID[steps[steps.length - 1] ? steps[steps.length - 1].toolId : ''];
      const p = newPipeline({
        steps,
        name: input.name || (first && last ? first.label + ' chain' : 'Pipeline'),
        inputType: input.inputType || (first ? first.in : 'txt') || 'txt',
        outputType: input.outputType || (last ? last.out : 'txt') || 'txt',
        origin: input.origin || 'agent',
        selfScore: input.selfScore == null ? null : Number(input.selfScore),
        agentRationale: input.rationale || null,
      });
      renderAll();
      return { ok: true, pipeline: p, validation: validatePipeline(p) };
    },
  });

  await window.mc.registerTool({
    name: 'pipeline_add_step',
    title: 'Append a transform to a pipeline',
    description: 'Append (or insert) one transform into an existing pipeline — this is what clicking a palette card does. Input {pipelineId?, toolId, position?}.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string' },
        toolId: { type: 'string' },
        position: { type: 'number', description: '0-based insert index; default append.' },
        params: { type: 'object' },
      },
      required: ['toolId'],
    },
    execute: async (input) => {
      const p = byId(input.pipelineId) || pick();
      if (!p) return { ok: false, error: 'no pipeline to add to' };
      if (!BY_ID[input.toolId]) return { ok: false, error: 'unknown toolId ' + input.toolId };
      const step = { toolId: input.toolId, params: input.params || {} };
      if (Number.isFinite(input.position)) p.steps.splice(Number(input.position), 0, step);
      else p.steps.push(step);
      const last = BY_ID[p.steps[p.steps.length - 1].toolId];
      if (last) p.outputType = last.out;
      p.lastScore = null;
      renderAll();
      return { ok: true, pipeline: p };
    },
  });

  await window.mc.registerTool({
    name: 'pipeline_delete',
    title: 'Delete a pipeline',
    description: 'Remove a pipeline from the canvas by id. Returns {ok, removed, remaining}.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (input) => {
      const i = store.pipelines.findIndex((p) => p.id === input.id);
      if (i === -1) return { ok: false, error: 'no pipeline ' + input.id };
      store.pipelines.splice(i, 1);
      if (store.selected === input.id) store.selected = store.pipelines.length ? store.pipelines[store.pipelines.length - 1].id : null;
      renderAll();
      return { ok: true, removed: input.id, remaining: store.pipelines.length };
    },
  });

  await window.mc.registerTool({
    name: 'pipeline_score',
    title: 'Score a pipeline against the trap catalogue',
    description: 'Send a pipeline to the SCORER ORIGIN (a different site) and return its verdict: {score, hits:[{trapId,severity,weight,title,lesson}], oracle, via}. Score starts at 100 and loses severity weights (high 34, medium 16, low 8) for every trap the chain triggers. The studio cannot import the engine — it must call it.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string' },
        notes: { type: 'object', description: 'Optional runtime evidence to include (emptyOutput, magicMismatch, emptyResult…).' },
      },
      required: ['pipelineId'],
    },
    execute: async (input) => {
      const p = byId(input.pipelineId);
      if (!p) return { ok: false, error: 'no pipeline ' + input.pipelineId };
      const res = await scoreViaOracle(p, input.notes || (p.lastRun ? p.lastRun.notes : {}) || {});
      p.lastScore = res;
      renderAll();
      logLine(res.hits && res.hits.length ? 'err' : 'ok',
        'score ' + esc(p.id) + ' → <b>' + res.score + '</b>/100 via ' + esc(res.oracle || '?') +
        ' · hits ' + (res.hits || []).map((h) => h.trapId).join(',') + ' (−' + res.penalty + ')');
      return Object.assign({ ok: true, pipelineId: p.id, inputType: p.inputType, outputType: p.outputType }, res);
    },
  });

  await window.mc.registerTool({
    name: 'pipeline_validate',
    title: 'Validate the chain',
    description: 'Check the pipeline type-by-type without running it: {ok, errors:[{kind,message,fix}], warnings, chain, endsAt, goal}. kinds: missing-connector (a step consumes a type the chain does not produce), goal-mismatch, unknown-tool, empty.',
    inputSchema: { type: 'object', properties: { pipelineId: { type: 'string' } }, required: ['pipelineId'] },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const p = byId(input.pipelineId);
      if (!p) return { ok: false, error: 'no pipeline ' + input.pipelineId };
      const v = validatePipeline(p);
      logLine(v.ok ? 'ok' : 'err', 'validate ' + esc(p.id) + ' → ' + (v.ok ? 'chain sound' : v.errors.length + ' error(s): ' + esc(v.errors.map((e) => e.kind).join(','))) + ' · ' + esc(v.chain.join('→')));
      return Object.assign({ pipelineId: p.id }, v);
    },
  });

  await window.mc.registerTool({
    name: 'pipeline_run',
    title: 'Execute a pipeline on a fixture',
    description: 'Actually execute the pipeline in this tab (REAL steps process real bytes; SIMULATED steps are tagged). Input {pipelineId, fixture?} where fixture is a fixture name or {name,b64,type}. Returns per-step {step,ok,bytesIn,bytesOut,magic,ms,meta} plus the final artifact (preview / dims / base64). Also streams to the run console and mirrors the resulting notes into pipeline_score.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string' },
        fixture: { type: 'string', description: 'Fixture name (see fixture_list). Defaults by input type.' },
        scoreAfter: { type: 'boolean', description: 'Re-score through the oracle with the run notes attached. Default true.' },
      },
      required: ['pipelineId'],
    },
    execute: async (input) => {
      const p = byId(input.pipelineId);
      if (!p) return { ok: false, error: 'no pipeline ' + input.pipelineId };
      let fixture = null;
      if (input.fixture && typeof input.fixture === 'object') {
        fixture = { name: input.fixture.name || 'inline', type: input.fixture.type, bytes: input.fixture.b64 ? bytesFromB64(input.fixture.b64) : null, text: input.fixture.text };
      } else {
        fixture = fixtureByName(input.fixture) || defaultFixtureFor(p.inputType);
      }
      if (!fixture) return { ok: false, error: 'no fixture named ' + input.fixture };
      logLine('head', '▶ ' + esc(p.name) + ' (' + esc(p.id) + ') on ' + esc(fixture.name) + ' — ' + esc(p.steps.map((s) => s.toolId).join(' → ')));
      const run = await runPipeline(p, fixture, {
        onStep: (ev) => {
          if (ev.phase === 'start') logLine('dim', '  ' + ev.step + '. ' + esc(ev.label) + ' [' + ev.mode + '] …');
          else if (ev.phase === 'end') {
            logLine('ok', '  ' + ev.step + '. ' + esc(ev.label) + ' ok · ' + ev.bytesIn + 'B → ' + ev.bytesOut + 'B · ' + ev.ms + 'ms' +
              (ev.magic ? ' · ' + esc(ev.magic) : '') + (Object.keys(ev.notes || {}).length ? ' · ⚠ ' + esc(Object.keys(ev.notes).join(',')) : ''));
            if (ev.artifact && ev.artifact.kind === 'png') {
              const div = logLine('ok', '     artifact:');
              const a = document.createElement('span');
              a.className = 'artifact';
              a.innerHTML = '<a href="' + ev.artifact.dataUrl + '" target="_blank" rel="noreferrer">' + ev.artifact.bytes + 'B png</a>';
              const img = document.createElement('img');
              img.src = ev.artifact.dataUrl;
              img.alt = 'pipeline png artifact';
              a.appendChild(img);
              div.appendChild(a);
            }
          } else logLine('err', '  ' + ev.step + '. ' + esc(ev.label) + ' FAILED: ' + esc(ev.error));
        },
      });
      p.lastRun = run;
      store.runs.unshift(Object.assign({ at: Date.now(), pipelineId: p.id, name: p.name, stepsSummary: p.steps.map((s) => s.toolId) }, {
        ok: run.ok, ms: run.ms, notes: run.notes, finalType: run.finalType, artifact: run.artifact && { type: run.artifact.type, bytes: run.artifact.bytes, preview: run.artifact.preview, dims: run.artifact.dims, magic: run.artifact.magic },
      }));
      if (store.runs.length > 60) store.runs.pop();
      document.getElementById('run-note').textContent = 'last run: ' + p.id + ' · ' + (run.ok ? 'ok' : 'failed') + ' · ' + run.ms + 'ms';
      if (input.scoreAfter !== false) {
        const res = await scoreViaOracle(p, run.notes);
        p.lastScore = res;
        logLine(res.hits.length ? 'err' : 'ok', '  → oracle re-scored the run: ' + res.score + '/100 · hits ' +
          (res.hits.length ? res.hits.map((h) => h.trapId).join(',') : 'none') + ' (evidence: ' + Object.keys(run.notes).join(',') + ')');
      }
      renderAll();
      return Object.assign({ ok: run.ok, pipelineId: p.id, fixture: fixture.name }, run);
    },
  });

  await window.mc.registerTool({
    name: 'fixture_list',
    title: 'List fixtures',
    description: 'List the fixtures the studio can run pipelines on, with type, byte size, sniffed magic bytes and a note about what each one is for. Returns {count, fixtures:[{name,type,bytes,bytesText,magic,note}]}.',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
    execute: async () => ({
      ok: true,
      count: store.fixtures.length,
      fixtures: store.fixtures.map((f) => ({
        name: f.name,
        type: f.type || f.kind,
        bytes: f.bytes ? f.bytes.length : null,
        bytesText: f.text != null ? textEncode(f.text).length : null,
        parts: f.files ? f.files.map((x) => ({ name: x.name, bytes: x.bytes })) : null,
        magic: f.bytes ? sniffMagic(f.bytes).magic : 'text/parts',
        note: f.note,
      })),
    }),
  });

  await window.mc.registerTool({
    name: 'fixture_upload',
    title: 'Add a fixture from base64',
    description: 'Register a new fixture from {name, b64, type?} (or {name, text, type?}). The bytes are magic-sniffed on arrival and the sniff result is reported — a .docx whose magic is not ZIP is exactly the renamed-file trap. Returns {ok, name, bytes, sniffed}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        b64: { type: 'string', description: 'base64 file bytes (data: URL prefix allowed).' },
        text: { type: 'string', description: 'Alternatively, plain text content.' },
        type: { type: 'string', description: 'Declared type; defaults to the sniffed magic type.' },
      },
      required: ['name'],
    },
    execute: async (input) => {
      if (!input || !input.name) return { ok: false, error: 'name required' };
      const bytes = input.b64 ? bytesFromB64(input.b64) : (input.text != null ? textEncode(input.text) : null);
      if (!bytes) return { ok: false, error: 'b64 or text required' };
      const sniffed = sniffMagic(bytes);
      const existing = fixtureByName(input.name);
      const rec = {
        name: input.name,
        type: input.type || sniffed.type,
        bytes,
        sniffed,
        note: 'uploaded ' + new Date().toISOString() + ' · sniffed "' + sniffed.magic + '"',
      };
      if (existing) Object.assign(existing, rec);
      else store.fixtures.push(rec);
      paintFixtures();
      logLine('ok', 'fixture +' + esc(input.name) + ' · ' + bytes.length + 'B · magic ' + esc(sniffed.magic) + ' · declared ' + esc(rec.type));
      return { ok: true, name: rec.name, bytes: bytes.length, sniffed, declaredType: rec.type, count: store.fixtures.length };
    },
  });

  await window.mc.registerTool({
    name: 'agent_propose',
    title: 'Ask the (scripted) agent for a pipeline',
    description: 'The scripted proposer returns a pipeline for a goal in words PLUS its own confidence self-score, then the external oracle scores the same chain. Returns {pipeline, selfScore, oracleScore, gap, hits, rationale}. The proposer is a script, not a model — it is written to look plausible, which is why the gap is usually positive on exactly the pipelines that break.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you want, in words, e.g. "summarize the scanned pdf".' },
        build: { type: 'boolean', description: 'Also create the pipeline on the canvas. Default true.' },
      },
      required: ['goal'],
    },
    execute: async (input) => {
      const goal = String(input.goal || '');
      const knownBad = /scan|bad|worst|break/i.test(goal);
      const proposal = knownBad ? knownBadProposal() : propose(goal);
      let pipeline = null;
      if (input.build !== false) {
        pipeline = newPipeline({
          steps: proposal.steps,
          name: proposal.name,
          inputType: proposal.inputType,
          outputType: proposal.outputType,
          origin: 'agent (scripted proposer)',
          selfScore: proposal.selfScore,
          agentRationale: proposal.rationale,
        });
        const oracle = await scoreViaOracle(pipeline, {});
        pipeline.lastScore = oracle;
        renderAll();
        return {
          ok: true,
          goal,
          rationale: proposal.rationale,
          selfScore: proposal.selfScore,
          selfNotes: proposal.selfNotes,
          oracleScore: oracle.score,
          gap: proposal.selfScore - oracle.score,
          hits: oracle.hits,
          scoredBy: oracle.oracle,
          via: oracle.via,
          pipeline: { id: pipeline.id, name: pipeline.name, steps: pipeline.steps.map((s) => s.toolId), inputType: pipeline.inputType, outputType: pipeline.outputType },
        };
      }
      const shadow = Object.assign({}, proposal, { steps: proposal.steps });
      const oracle = await scoreViaOracle({ steps: shadow.steps, inputType: proposal.inputType, outputType: proposal.outputType }, {});
      return { ok: true, goal, proposal, oracleScore: oracle.score, gap: proposal.selfScore - oracle.score, hits: oracle.hits };
    },
  });

  await window.mc.registerTool({
    name: 'step_explain',
    title: 'Explain one transform',
    description: 'Honest dossier on a single transform: {toolId, label, mode, engine, detail, traps:[{id,severity,pattern,lesson}]} — the REAL/SIMULATED badge, what actually executes, and every trap it is implicated in.',
    inputSchema: { type: 'object', properties: { toolId: { type: 'string' } }, required: ['toolId'] },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const def = BY_ID[input.toolId];
      if (!def) return { ok: false, error: 'unknown toolId ' + input.toolId, known: Object.keys(BY_ID) };
      const traps = (def.traps || []).map((id) => TRAPS.find((t) => t.id === id)).filter(Boolean)
        .map((t) => ({ id: t.id, severity: t.severity, weight: SEVERITY_WEIGHT[t.severity], pattern: t.pattern, lesson: t.lesson }));
      return {
        ok: true, toolId: def.id, label: def.label, mode: def.mode,
        honestBadge: def.mode === 'real' ? 'REAL' : 'SIMULATED',
        in: def.in, out: def.out, engine: def.engine, detail: def.detail || null,
        traps, params: def.params || {},
      };
    },
  });

  await window.mc.registerTool({
    name: 'run_history',
    title: 'Recent runs',
    description: 'The run log: [{at, pipelineId, name, ok, ms, finalType, notes, artifact:{type,bytes,preview,dims,magic}}] most-recent-first, plus per-run trap evidence. Returns {count, runs}.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const limit = Math.max(1, Math.min(60, Number(input && input.limit) || 20));
      return { ok: true, count: store.runs.length, runs: store.runs.slice(0, limit) };
    },
  });

  await window.mc.registerTool({
    name: 'oracle_call',
    title: 'Call the external scorer directly',
    description: 'Raw pass-through to the oracle origin: {tool: "score_pipeline"|"trap_list", ...args}. Proves the engine is elsewhere — the reply carries oracle:"scorer:&lt;origin&gt;" and only arrives after a getTools({fromOrigins}) route. trap_list returns the full catalogue with severity weights.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['score_pipeline', 'trap_list'] },
        steps: stepArraySchema,
        notes: { type: 'object' },
        inputType: { type: 'string' },
        outputType: { type: 'string' },
        id: { type: 'string', description: 'trap id for trap_list' },
      },
      required: ['tool'],
    },
    execute: async (input) => {
      const name = input.tool === 'trap_list' ? 'trap_list' : 'score_pipeline';
      const payload = input.tool === 'trap_list' ? (input.id ? { id: input.id } : {}) : {
        steps: normaliseSteps(input.steps), notes: input.notes || {}, inputType: input.inputType, outputType: input.outputType,
      };
      const res = await callScorerTool(name, payload);
      return Object.assign({ ok: true, via: IS_MULTI ? 'fromOrigins(cross-origin)' : 'same-origin fallback', from: SCORER_ORIGIN }, res);
    },
  });

  /* dynamic surface: registering/unregistering this one is visible in the tool list + mc-toolchange */
  await registerProbe();
}

let probeRegistered = false;
async function registerProbe() {
  if (probeRegistered) return;
  controllers.probe = new AbortController();
  await window.mc.registerTool({
    name: 'recipe_bad_pipeline',
    title: 'Load the known-bad recipe',
    description: 'Seed the canvas with the pipeline we know breaks (scan → rasterize → ocr → scan-tables, input type "scan") and return the oracle verdict for it. Expect a LOW score with T01, T09 and T12 among the hits.',
    inputSchema: { type: 'object' },
    execute: async () => {
      const p = newPipeline(knownBadProposal().buildFields('Known-bad: scan → ocr → summary'));
      const oracle = await scoreViaOracle(p, {});
      p.lastScore = oracle;
      renderAll();
      return { ok: true, pipelineId: p.id, steps: p.steps.map((s) => s.toolId), score: oracle.score, hits: oracle.hits.map((h) => ({ trapId: h.trapId, severity: h.severity })), oracle: oracle.oracle };
    },
  }, { signal: controllers.probe.signal });
  probeRegistered = true;
}

function knownBadProposal() {
  return {
    name: 'Known-bad: scan → ocr → tables',
    inputType: 'scan',
    outputType: 'csv-of-tables',
    selfScore: 93,
    rationale: 'Paint the page, OCR the pixels, read the tables out of the scan. Every step reports success, which is exactly the failure class we are testing for.',
    selfNotes: 'self-score from the proposer: three steps that all return 0.',
    steps: [{ toolId: 'pdf-rasterize' }, { toolId: 'ocr' }, { toolId: 'png-tables' }],
    buildFields(name) {
      return {
        name,
        steps: this.steps,
        inputType: this.inputType,
        outputType: this.outputType,
        origin: 'seeded (known-bad)',
        selfScore: this.selfScore,
        agentRationale: this.rationale,
      };
    },
  };
}

function knownGoodPipeline() {
  return {
    name: 'Known-good: docx → md (via zip)',
    steps: [{ toolId: 'docx-text' }, { toolId: 'text-md' }],
    inputType: 'docx',
    outputType: 'md',
    rationale: 'Open the OOXML package, inflate word/document.xml, walk the runs, then re-impose heading structure. Nothing is rendered, nothing is guessed.',
    selfScore: 100,
  };
}

/* ------------------------------------------------------------- wiring */

function wireUi() {
  document.getElementById('btn-build').addEventListener('click', async () => {
    const inputType = document.getElementById('input-type').value;
    const outputType = document.getElementById('goal-type').value;
    const chain = planChain(inputType, outputType);
    const p = newPipeline({
      name: inputType + ' → ' + outputType,
      inputType, outputType, origin: 'human',
      steps: chain || [],
      agentRationale: chain ? 'planned chain: ' + chain.map((s) => s.toolId).join(' → ') : 'no chain in the catalogue reaches ' + outputType + ' from ' + inputType + ' — build it by hand.',
    });
    const oracle = await scoreViaOracle(p, {});
    p.lastScore = oracle;
    logLine('head', '✂ new recipe ' + esc(p.id) + ': ' + esc(inputType) + ' → ' + esc(outputType) +
      (chain ? ' · chain ' + chain.map((s) => s.toolId).join(' → ') : ' · empty, awaiting hands'));
    renderAll();
  });

  document.getElementById('btn-plan').addEventListener('click', async () => {
    const p = pick();
    const inputType = document.getElementById('input-type').value;
    const outputType = document.getElementById('goal-type').value;
    const chain = planChain(inputType, outputType);
    const target = p || newPipeline({ name: inputType + ' → ' + outputType, inputType, outputType, origin: 'human' });
    document.getElementById('plan-hint').textContent = chain
      ? 'planned: ' + chain.map((s) => s.toolId).join(' → ')
      : 'no chain in the catalogue reaches ' + outputType + ' from ' + inputType;
    if (chain) {
      target.steps = chain.map((s) => ({ toolId: s.toolId, params: {} }));
      target.inputType = inputType;
      target.outputType = outputType;
      const oracle = await scoreViaOracle(target, {});
      target.lastScore = oracle;
    }
    renderAll();
  });

  document.getElementById('btn-ask').addEventListener('click', async () => {
    const goal = document.getElementById('agent-goal').value || 'turn a pdf into a summary';
    const r = await window.__agent.call('agent_propose', { goal });
    showCall('agent_propose', r);
    renderCanvas();
  });

  document.getElementById('btn-bad').addEventListener('click', async () => {
    const r = await window.__agent.call('agent_propose', { goal: 'summarize the scanned pdf (give me the bad one)' });
    showCall('agent_propose', r);
    renderCanvas();
  });

  document.getElementById('btn-good').addEventListener('click', async () => {
    const g = knownGoodPipeline();
    const p = newPipeline({ name: g.name, steps: g.steps, inputType: g.inputType, outputType: g.outputType, origin: 'seeded (known-good)', agentRationale: g.rationale, selfScore: g.selfScore });
    const oracle = await scoreViaOracle(p, {});
    p.lastScore = oracle;
    logLine('head', '✂ known-good seeded: ' + esc(p.id) + ' → oracle says ' + oracle.score + '/100');
    renderAll();
  });

  document.getElementById('palette-filter').addEventListener('input', renderPalette);

  document.getElementById('btn-oracle-inspect').addEventListener('click', async () => {
    const r = await window.__agent.call('oracle_call', { tool: 'trap_list' });
    document.getElementById('oracle-out').textContent = JSON.stringify(r, null, 2);
    logLine('head', 'oracle catalogue: ' + r.count + ' traps · ' + esc(r.oracle || r.from));
  });

  document.getElementById('btn-call').addEventListener('click', async () => {
    const name = document.getElementById('call-tool').value;
    let input = {};
    try { input = JSON.parse(document.getElementById('call-input').value || '{}'); }
    catch (e) { showCall(name, { error: 'input is not JSON: ' + String(e) }); return; }
    try {
      const raw = await window.__agent.call(name, input);
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch (e) { /* string result */ }
      showCall(name, parsed);
      renderCanvas();
    } catch (e) {
      showCall(name, { error: String(e && e.message ? e.message : e) });
    }
  });

  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    store.runs = [];
    document.getElementById('console-lines').innerHTML = '';
    document.getElementById('run-note').textContent = 'history cleared';
    renderCanvas();
  });

  // dynamic surface demo: register/unregister a tool through an AbortController
  const wrap = document.createElement('div');
  wrap.innerHTML = '<label class="hint" style="display:flex;gap:6px;align-items:center;margin-top:10px">' +
    '<input type="checkbox" id="chk-probe" checked style="width:auto"> expose <code>recipe_bad_pipeline</code> to agents ' +
    '<span class="muted">(unchecking aborts its signal → <code>mc-toolchange</code>)</span></label>';
  document.querySelector('.oracle-card').appendChild(wrap);
  wrap.querySelector('#chk-probe').addEventListener('change', async (ev) => {
    if (ev.target.checked) { await registerProbe(); }
    else { controllers.probe.abort(); probeRegistered = false; }
    await renderToolList();
  });

  window.addEventListener('mc-toolchange', () => {
    store.toolChanges = (store.toolChanges || 0) + 1;
    renderToolList();
  });

  document.getElementById('input-type').addEventListener('change', () => {
    const f = defaultFixtureFor(document.getElementById('input-type').value);
    if (f) document.getElementById('fixture-id').value = f.name;
  });
}

async function mountScorer() {
  const el = document.getElementById('scorer-frame');
  const loaded = new Promise((r) => el.addEventListener('load', r, { once: true }));
  el.src = IS_MULTI ? SCORER_ORIGIN + '/index.html' : './scorer/index.html';
  await loaded;
  await window.MCwhenChild(el);
  store.scorerMounted = true;
}

async function seed() {
  const bad = knownBadProposal();
  const pBad = newPipeline(Object.assign(bad.buildFields(bad.name), { origin: 'seeded (known-bad)' }));
  pBad.lastScore = await scoreViaOracle(pBad, {});
  const good = knownGoodPipeline();
  const pGood = newPipeline({ name: good.name, steps: good.steps, inputType: good.inputType, outputType: good.outputType, origin: 'seeded (known-good)', agentRationale: good.rationale, selfScore: good.selfScore });
  pGood.lastScore = await scoreViaOracle(pGood, {});
  store.selected = pBad.id;
}

/* ---------------------------------------------------------------- boot */

async function boot() {
  try {
    buildFixtures();
    renderSelects();
    renderPalette();
    wireUi();
    await registerTools();
    await mountScorer();
    await seed();
    renderAll();
    await renderToolList();
    logLine('head', 'studio ready · ' + CATALOG.length + ' transforms (' + CATALOG.filter((t) => t.mode === 'real').length +
      ' REAL, ' + CATALOG.filter((t) => t.mode === 'simulated').length + ' SIMULATED) · ' + TRAPS.length +
      ' traps on the oracle origin' + (IS_MULTI ? ' (' + SCORER_ORIGIN + ')' : ' (same-origin fallback)'));
    window.__recipe = {
      store, scoreViaOracle, callScorerTool, knownGoodPipeline, knownBadProposal,
      scoreLocally, SCORER_ORIGIN, SCORER_DECOY, localEngine: TRAP_ENGINE,
    };
    window.__appReady = true;
    window.__ready = true;
  } catch (err) {
    window.__bootError = String(err && err.stack ? err.stack : err);
    document.getElementById('console-lines').innerHTML = '<div class="line err">boot failed: ' + esc(window.__bootError) + '</div>';
    window.__appReady = true;
    window.__ready = true;
    throw err;
  }
}

boot();
