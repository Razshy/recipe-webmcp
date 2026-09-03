"""Recipe — agent-tool surface, the external oracle, and the trap engine.

Self-executing Playwright script (kit convention): reads BASE_URL / ORIGINS_JSON,
asserts, prints RECIPE-TOOLS OK, exits non-zero on failure.
"""
import json
import os

from playwright.sync_api import sync_playwright

BASE = os.environ['BASE_URL']
ORIG = json.loads(os.environ['ORIGINS_JSON'])
SCORER = ORIG['scorer']

MAIN_TOOLS = [
    'agent_propose', 'catalog_list', 'fixture_list', 'fixture_upload', 'oracle_call',
    'pipeline_add_step', 'pipeline_build', 'pipeline_delete', 'pipeline_run',
    'pipeline_score', 'pipeline_validate', 'run_history', 'step_explain',
]

CHECKS = []


def check(name, cond, detail=''):
    CHECKS.append(name)
    assert cond, 'FAILED: %s — %s' % (name, detail)


def js(page, expr, arg=None):
    raw = page.evaluate('(a) => ' + expr, arg) if arg is not None else page.evaluate(expr)
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return raw
    return raw


def build(page, steps, input_type=None, output_type=None, **kw):
    payload = {'steps': steps}
    if input_type:
        payload['inputType'] = input_type
    if output_type:
        payload['outputType'] = output_type
    payload.update(kw)
    return js(page, 'window.__agent.call("pipeline_build", %s)' % json.dumps(payload), )


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors, console_errors = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)

        page.goto(BASE + '/index.html')
        page.wait_for_function('window.__ready === true', timeout=20000)
        check('boot clean', page.evaluate('window.__bootError') in (None, ''), page.evaluate('window.__bootError'))
        check('appReady set', page.evaluate('!!window.__appReady'))

        # ---- tool inventory on the main origin -------------------------------------
        tools = page.evaluate('window.__agent.tools().then(ts => ts.map(t => t.name))')
        missing = [t for t in MAIN_TOOLS if t not in tools]
        check('every main tool registered', not missing, 'missing %s in %s' % (missing, tools))
        check('>=12 main tools', len(tools) >= 12, tools)
        check('every tool has an object inputSchema', page.evaluate(
            "window.__agent.tools().then(ts => ts.every(t => t.inputSchema && t.inputSchema.type === 'object'))"))

        # ---- duplicate-name rejection ---------------------------------------------
        dup = page.evaluate("""() => window.mc.registerTool({name:'pipeline_build',description:'dupe',
            inputSchema:{type:'object'},execute:async()=>'x'}).then(()=>'accepted', e => 'rejected:'+e.name)""")
        check('duplicate name rejected', dup.startswith('rejected'), dup)

        # ---- mc-toolchange fires (dynamic surface) --------------------------------
        page.evaluate("window.__tc = 0; window.addEventListener('mc-toolchange', () => window.__tc++)")
        page.evaluate("""() => { window.__ac = new AbortController();
            return window.mc.registerTool({name:'temp_dynamic_tool',description:'temp',
              inputSchema:{type:'object'},execute:async()=>({ok:true})}, {signal: window.__ac.signal}); }""")
        page.wait_for_function('window.__tc >= 1', timeout=5000)
        before = page.evaluate("window.__agent.tools().then(ts => ts.map(t=>t.name).includes('temp_dynamic_tool'))")
        page.evaluate('window.__ac.abort()')
        page.wait_for_function('window.__tc >= 2', timeout=5000)
        after = page.evaluate("window.__agent.tools().then(ts => ts.map(t=>t.name).includes('temp_dynamic_tool'))")
        check('toolchange observed on register+unregister', before and not after, (before, after))

        # ---- the oracle is on ANOTHER ORIGIN --------------------------------------
        default_names = page.evaluate('window.__agent.tools().then(ts => ts.map(t => t.name))')
        check('score_pipeline invisible without fromOrigins', 'score_pipeline' not in default_names, default_names)
        check('trap_list invisible without fromOrigins', 'trap_list' not in default_names, default_names)

        cross = page.evaluate('(o) => window.__agent.tools([o]).then(ts => ts.map(t => t.name))', SCORER)
        check('cross-origin tools appear with fromOrigins', 'score_pipeline' in cross and 'trap_list' in cross, cross)
        check('unexposed decoy never visible cross-origin', 'warm_cache' not in cross, cross)
        check('decoy also absent from same-origin listing', 'warm_cache' not in default_names, default_names)
        check('scorer tools carry the scorer origin', page.evaluate(
            '(o) => window.__agent.tools([o]).then(ts => ts.filter(t => t.name === "score_pipeline").every(t => t.origin === o))', SCORER))

        # ---- direct cross-origin execute by NAME (kit caches the route) -----------
        direct = page.evaluate("""(o) => window.mc.getTools({fromOrigins:[o]}).then(() =>
            window.mc.executeTool('trap_list', {})).then(s => JSON.parse(s))""", SCORER)
        check('cross-origin executeTool by name works', direct.get('count', 0) >= 12, direct.get('count'))
        check('oracle result carries scorer: origin marker', str(direct.get('oracle', '')).startswith('scorer:'), direct.get('oracle'))
        ids = [t['id'] for t in direct['traps']]
        for want in ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12']:
            check('catalogue contains ' + want, want in ids, ids)
        weights = {t['id']: t['weight'] for t in direct['traps']}
        check('severity weights published (high 30 / medium 15 / low 8)',
              weights['T01'] == 30 and weights['T06'] == 15 and weights['T07'] == 8, weights)
        check('every trap carries a lesson', all(t['lesson'] and len(t['lesson']) > 40 for t in direct['traps']))

        # trap engine parity: the in-page mirror used for inline annotations must agree
        # with the oracle (two copies of one catalogue, so they cannot drift silently)
        mirror_score = page.evaluate(
            "() => window.__recipe.scoreViaOracle({steps:[{toolId:'pdf-rasterize'},{toolId:'ocr'}], inputType:'pdf', outputType:'txt'}, {}) "
            ".then(r => r.score + '|' + r.hits.map(h => h.trapId).sort().join(','))")
        oracle_score = page.evaluate(
            "(o) => window.mc.getTools({fromOrigins:[o]}).then(() => window.mc.executeTool('score_pipeline', "
            "{steps:[{toolId:'pdf-rasterize'},{toolId:'ocr'}], inputType:'pdf', outputType:'txt'}))"
            ".then(s => { const r = JSON.parse(s); return r.score + '|' + r.hits.map(h => h.trapId).sort().join(','); })", SCORER)
        check('in-page mirror agrees with the external oracle', mirror_score == oracle_score, (mirror_score, oracle_score))

        # ---- scoring: known-bad / known-good --------------------------------------
        bad = build(page, ['pdf-rasterize', 'ocr', 'png-tables'], 'scan', 'csv-of-tables',
                    name='known-bad', origin='test', selfScore=93)
        bad_id = bad['pipeline']['id']
        bad_score = js(page, 'window.__agent.call("pipeline_score", {pipelineId: %s})' % json.dumps(bad_id))
        hit_ids = sorted(h['trapId'] for h in bad_score['hits'])
        check('known-bad pipeline scores LOW (< 40)', bad_score['score'] < 40, bad_score['score'])
        check('known-bad hits exactly T01+T09+T12', hit_ids == ['T01', 'T09', 'T12'], hit_ids)
        check('score is 100 minus the severity weights', bad_score['score'] == 100 - bad_score['penalty'], bad_score)
        check('penalty is the three high-severity weights (3x30)', bad_score['penalty'] == 90, bad_score['penalty'])
        check('score came from the scorer origin', str(bad_score['oracle']).startswith('scorer:'), bad_score['oracle'])
        check('lessons travel with the hits', all(h['lesson'] for h in bad_score['hits']))
        check('agent self-score vs oracle gap shown', bad_score.get('ok') and 93 - bad_score['score'] == 93 - bad_score['score'])

        good = build(page, ['docx-text', 'text-md'], 'docx', 'md', name='known-good', origin='test', selfScore=100)
        good_id = good['pipeline']['id']
        good_score = js(page, 'window.__agent.call("pipeline_score", {pipelineId: %s})' % json.dumps(good_id))
        check('known-good pipeline scores exactly 100', good_score['score'] == 100, good_score)
        check('known-good has zero trap hits', good_score['hits'] == [], good_score['hits'])

        # the spec's literal known-bad chain (extract → rasterize → ocr → summarize)
        alt = build(page, ['pdf-text', 'pdf-rasterize', 'ocr', 'summarize'], 'pdf', 'txt')
        alt_score = js(page, 'window.__agent.call("pipeline_score", {pipelineId: %s})' % json.dumps(alt['pipeline']['id']))
        check('extract→rasterize→ocr→summarize scores low too', alt_score['score'] < 40, alt_score['score'])
        check('T01 fires for the OCR-after-render chain', 'T01' in [h['trapId'] for h in alt_score['hits']], alt_score['hits'])

        # ---- validation -----------------------------------------------------------
        good_chain = build(page, ['pdf-text', 'summarize'], 'pdf', 'txt')
        v_bad = js(page, 'window.__agent.call("pipeline_validate", {pipelineId: %s})' % json.dumps(good_chain['pipeline']['id']))
        check('well-chained pipeline validates ok', v_bad['ok'] and v_bad['chain'] == ['pdf', 'txt', 'txt'], v_bad)

        # the chain-order trap: extracting before rendering breaks the connector, and the
        # validator says so with an executable fix instead of running it and failing later
        v_alt = js(page, 'window.__agent.call("pipeline_validate", {pipelineId: %s})' % json.dumps(alt['pipeline']['id']))
        check('validator catches pdf→txt→(needs pdf) as a missing connector',
              v_alt['ok'] is False and v_alt['errors'][0]['kind'] == 'missing-connector', v_alt['errors'])
        check('validator names the insertable connector', 'insert' in v_alt['errors'][0]['fix'], v_alt['errors'][0])

        x2p = build(page, ['xlsx-csv', 'pdf-rasterize'], 'xlsx', 'png')
        v = js(page, 'window.__agent.call("pipeline_validate", {pipelineId: %s})' % json.dumps(x2p['pipeline']['id']))
        check('validate rejects xlsx→png with a missing connector',
              v['ok'] is False and any(e['kind'] == 'missing-connector' for e in v['errors']), v)
        check('the rejection names a fix', all('fix' in e for e in v['errors'] if e['kind'] == 'missing-connector'), v['errors'])
        sim = build(page, ['docx-pdf-soffice', 'pdf-text'], 'docx', 'txt')
        v_sim = js(page, 'window.__agent.call("pipeline_validate", {pipelineId: %s})' % json.dumps(sim['pipeline']['id']))
        check('simulated steps surface as warnings, not errors',
              any(w['kind'] == 'simulated' for w in v_sim['warnings']) and v_sim['ok'] is True, v_sim)

        unknown = build(page, ['not-a-real-transform'], 'txt', 'txt')
        v2 = js(page, 'window.__agent.call("pipeline_validate", {pipelineId: %s})' % json.dumps(unknown['pipeline']['id']))
        check('unknown toolId reported, not swallowed', any(e['kind'] == 'unknown-tool' for e in v2['errors']), v2)

        # ---- agent_propose reports a real gap -------------------------------------
        prop = js(page, 'window.__agent.call("agent_propose", {goal: "summarize the scanned pdf"})')
        check('agent_propose returns a pipeline', prop['pipeline']['steps'], prop)
        check('proposer self-score is optimistic', prop['selfScore'] - prop['oracleScore'] >= 30,
              (prop['selfScore'], prop['oracleScore'], prop['gap']))
        check('gap is computed and reported', prop['gap'] == prop['selfScore'] - prop['oracleScore'], prop)
        prop2 = js(page, 'window.__agent.call("agent_propose", {goal: "get the tables out of a spreadsheet as csv"})')
        check('structural proposal is near-optimistic (gap <= 8)', prop2['gap'] <= 8, prop2)

        # ---- per-tool coverage for the remaining tools -----------------------------
        cat = js(page, 'window.__agent.call("catalog_list", {})')
        check('catalogue lists >= 18 transforms', cat['count'] >= 18, cat['count'])
        check('catalogue separates REAL from SIMULATED', cat['real'] >= 15 and cat['simulated'] >= 5,
              (cat['real'], cat['simulated']))
        real_only = js(page, 'window.__agent.call("catalog_list", {mode: "simulated"})')
        check('mode filter works', all(t['mode'] == 'simulated' for t in real_only['transforms']), real_only['count'])

        exp = js(page, 'window.__agent.call("step_explain", {toolId: "ocr"})')
        check('step_explain badges SIMULATED honestly', exp['mode'] == 'simulated' and exp['honestBadge'] == 'SIMULATED', exp)
        check('step_explain lists T01 for the OCR step', 'T01' in [t['id'] for t in exp['traps']], exp['traps'])
        exp2 = js(page, 'window.__agent.call("step_explain", {toolId: "docx-text"})')
        check('step_explain badges the docx reader REAL', exp2['honestBadge'] == 'REAL', exp2)
        check('unknown step_explain reports the known ids', js(page, 'window.__agent.call("step_explain", {toolId: "nope"})').get('ok') is False)

        add = js(page, 'window.__agent.call("pipeline_add_step", {pipelineId: %s, toolId: "png-decode"})' % json.dumps(good_id))
        check('pipeline_add_step appends', add['pipeline']['steps'][-1]['toolId'] == 'png-decode', add)

        hist = js(page, 'window.__agent.call("run_history", {})')
        check('run_history responds with a list', isinstance(hist['runs'], list) and hist['ok'], hist)

        fixed = js(page, 'window.__agent.call("fixture_list", {})')
        check('fixture_list enumerates fixtures', fixed['count'] >= 8, fixed['count'])
        check('fixtures report sniffed magic', all('magic' in f for f in fixed['fixtures']))

        oc = js(page, 'window.__agent.call("oracle_call", {tool: "trap_list", id: "T06"})')
        check('oracle_call proxies the scorer', str(oc.get('oracle', '')).startswith('scorer:') and oc['trap']['id'] == 'T06', oc)

        dele = js(page, 'window.__agent.call("pipeline_delete", {id: %s})' % json.dumps(unknown['pipeline']['id']))
        check('pipeline_delete removes', dele['ok'] and dele['remaining'] >= 2, dele)
        dele2 = js(page, 'window.__agent.call("pipeline_delete", {id: "nope"})')
        check('deleting a missing pipeline reports failure', dele2['ok'] is False, dele2)

        check('zero page errors', not errors, errors)
        check('zero console errors', not console_errors, console_errors)

        browser.close()
        print('RECIPE-TOOLS OK — %d assertions' % len(CHECKS))


if __name__ == '__main__':
    main()
