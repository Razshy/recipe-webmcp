"""Recipe — the WebMCP surface: inventory, schemas, cross-origin visibility, bridges, error
envelopes, duplicate names, and the human-armed pipeline_delete (toolchange).

Runs identically against the kit shim and native WebMCP (kit/harness.py --mode both).
"""
import re

from testkit import MODE, ORIGINS, browser, call, call_error, done, errors, frame, new_page, ok, open_page, tools

SCORER = ORIGINS['scorer']
MAIN = ORIGINS['main']

MAIN_TOOLS = [
    'catalog_list', 'fixture_list', 'fixture_upload', 'oracle_score_pipeline', 'oracle_trap_list',
    'pipeline_add_step', 'pipeline_build', 'pipeline_list', 'pipeline_plan', 'pipeline_propose',
    'pipeline_remove_step', 'pipeline_run', 'pipeline_score', 'pipeline_seed_bad', 'pipeline_validate',
    'run_history', 'step_explain',
]
READ_ONLY = {'catalog_list', 'fixture_list', 'oracle_score_pipeline', 'oracle_trap_list', 'pipeline_list',
             'pipeline_plan', 'pipeline_validate', 'run_history', 'step_explain', 'score_pipeline', 'trap_list'}
NAME_RE = re.compile(r'^[a-z][a-z0-9_]{1,29}$')


def schema_problems(t):
    """Checklist S1-S5 for one tool; returns a list of problems."""
    out = []
    s = t['inputSchema']
    if not isinstance(s, dict) or s.get('type') != 'object':
        return ['schema is not an object schema']
    if s.get('additionalProperties') is not False:
        out.append('additionalProperties not false')
    for name, prop in (s.get('properties') or {}).items():
        if 'type' not in prop:
            out.append(name + ': no type')
        if not prop.get('description') or len(prop['description']) > 150:
            out.append(name + ': description missing or > 150 chars')
    return out


def step_rows(pg, pid):
    return pg.locator('[data-pid="%s"] [data-test="step-row"]' % pid).count()


def main():
    with browser() as b:
        pg = new_page(b)
        open_page(pg, timeout=30000)
        ok(pg.evaluate('window.__bootError') is None, 'studio booted without a boot error', pg.evaluate('window.__bootError'))
        ok(pg.evaluate('window.MC.native') == (MODE == 'native'), 'MC.native reports the mode: ' + MODE)
        ok(pg.evaluate('window.MC.isMulti') is True, 'multi-origin mode under the kit server')
        scorer = frame(pg, 'scorer')
        ok(scorer is not None and scorer.evaluate('window.__appReady === true'), 'scorer frame is up on its own origin')
        ok(scorer.evaluate('window.__bootError') is None, 'scorer registered its tools without error (allow="tools" honoured)', scorer.evaluate('window.__bootError'))

        # --- inventory ---------------------------------------------------------------
        own = tools(pg)
        own_names = [t['name'] for t in own]
        ok(own_names == MAIN_TOOLS, 'top-level tool set is exactly the documented 17 (sorted by name)', own_names)
        ok('score_pipeline' not in own_names and 'trap_list' not in own_names, 'oracle tools are invisible without fromOrigins')
        cross = tools(pg, [SCORER])
        cross_names = [t['name'] for t in cross]
        ok('score_pipeline' in cross_names and 'trap_list' in cross_names, 'fromOrigins reveals the two exposed oracle tools', cross_names)
        ok('warm_cache' not in cross_names, 'the unexposed warm_cache stays hidden even with fromOrigins')
        ok(all(t['origin'] == SCORER for t in cross if t['name'] in ('score_pipeline', 'trap_list')), 'oracle tools carry the scorer origin')
        problems = {t['name']: schema_problems(t) for t in cross}
        problems = {k: v for k, v in problems.items() if v}
        ok(not problems, 'every schema is a closed object with typed, described properties', problems)
        ok(all(NAME_RE.match(t['name']) for t in cross), 'names are snake_case and <= 30 chars', cross_names)
        long_desc = [t['name'] for t in cross if not t['description'] or len(t['description']) > 500]
        ok(not long_desc, 'descriptions are non-empty and <= 500 chars', long_desc)
        ok(all(t['title'] for t in cross), 'every tool has a title')
        ann = {t['name']: t['annotations'] for t in cross}
        ok(all(isinstance(a, dict) and isinstance(a.get('readOnlyHint'), bool) for a in ann.values()), 'every tool sets readOnlyHint explicitly', ann)
        ok({n for n, a in ann.items() if a['readOnlyHint']} == READ_ONLY, 'readOnlyHint is true on exactly the read tools', {n for n, a in ann.items() if a['readOnlyHint']})
        ok(all(set(a.keys()) <= {'readOnlyHint', 'untrustedContentHint'} for a in ann.values()), 'only spec annotation keys are used')
        ok(ann['fixture_upload'].get('untrustedContentHint') is True and ann['run_history'].get('untrustedContentHint') is True, 'tools echoing uploaded content flag untrustedContentHint')

        # --- duplicate name -----------------------------------------------------------
        dup = pg.evaluate("window.mc.registerTool({name:'pipeline_build', description:'dupe', inputSchema:{type:'object'}, execute: async () => 'x'}).then(() => 'accepted', e => e.name)")
        ok(dup == 'InvalidStateError', 'duplicate tool name rejects with InvalidStateError', dup)

        # --- bridges really relay to the oracle origin ----------------------------------
        direct = call(pg, 'trap_list', {})
        bridged = call(pg, 'oracle_trap_list', {})
        ok(bridged['bridgedTo'] == 'trap_list' and bridged['from'] == SCORER, 'oracle_trap_list names the tool and origin it bridged to', {k: bridged.get(k) for k in ('bridgedTo', 'from')})
        ok(bridged['traps'] == direct['traps'] and bridged['count'] == 15 and bridged['oracle'] == direct['oracle'], 'bridged catalogue equals the direct cross-origin call (15 traps)', (bridged['count'], direct['count']))
        ok(direct['oracle'] == 'scorer:' + SCORER and direct['weights'] == {'high': 30, 'medium': 15, 'low': 8}, 'oracle marks its replies with its own origin and publishes its weights', direct.get('oracle'))
        one = call(pg, 'oracle_trap_list', {'id': 'T04', 'format': 'detailed'})
        ok(one['ok'] and one['trap']['id'] == 'T04' and 'exit 0' in one['trap']['lesson'], 'bridge relays the id argument and returns one trap in full', one)
        bs = call(pg, 'oracle_score_pipeline', {'steps': ['pdf-rasterize', 'ocr'], 'inputType': 'pdf', 'outputType': 'txt'})
        ds = call(pg, 'score_pipeline', {'steps': ['pdf-rasterize', 'ocr'], 'inputType': 'pdf', 'outputType': 'txt'})
        ok(bs['ok'] and bs['score'] == ds['score'] == 70 and [h['trapId'] for h in bs['hits']] == ['T01'] and bs['bridgedTo'] == 'score_pipeline', 'oracle_score_pipeline relays a scoring request and matches the direct call', (bs.get('score'), ds.get('score')))
        ok(bs['hits'][0]['basis'] == 'plan', 'a hit that needs no runtime evidence is labelled basis "plan"', bs['hits'])
        after = scorer.evaluate("document.getElementById('calls').textContent")
        ok('calls: ' in after and int(after.split(':')[1]) >= 2, 'the oracle page counts the calls it served', after)

        # --- error envelopes: returned, never thrown ------------------------------------
        cases = [
            ('catalog_list', {'mode': 'bogus'}, 'invalid_param'),
            ('catalog_list', {'io': 'nothing-produces-this'}, 'empty_result'),
            ('step_explain', {'toolId': 'nope'}, 'not_found'),
            ('step_explain', {}, 'invalid_param'),
            ('fixture_upload', {'name': 'x'}, 'invalid_param'),
            ('fixture_upload', {'name': 'x', 'b64': '%%%not-base64%%%'}, 'invalid_param'),
            ('fixture_upload', {'name': 'bad name!', 'text': 'hi'}, 'invalid_param'),
            ('pipeline_plan', {'inputType': 'png', 'outputType': 'xlsx'}, 'empty_result'),
            ('pipeline_build', {'steps': 'pdf-text'}, 'invalid_param'),
            ('pipeline_build', {'steps': [None]}, 'invalid_param'),
            ('pipeline_build', {'steps': ['pdf-text'], 'origin': 'martian'}, 'invalid_param'),
            ('pipeline_add_step', {'pipelineId': 'does-not-exist', 'toolId': 'png-decode'}, 'not_found'),
            ('pipeline_add_step', {'toolId': 'not-a-transform'}, 'not_found'),
            ('pipeline_add_step', {'toolId': 'png-decode', 'position': -1}, 'invalid_param'),
            ('pipeline_remove_step', {'position': 99}, 'invalid_param'),
            ('pipeline_validate', {'pipelineId': 'p999'}, 'not_found'),
            ('pipeline_score', {'pipelineId': 'p999'}, 'not_found'),
            ('pipeline_run', {'fixture': 'this-fixture-does-not-exist'}, 'not_found'),
            ('pipeline_run', {'format': 'verbose'}, 'invalid_param'),
            ('pipeline_propose', {}, 'invalid_param'),
            ('run_history', {'limit': 0}, 'invalid_param'),
            ('score_pipeline', {'steps': 'garbage'}, 'invalid_param'),
            ('score_pipeline', {}, 'invalid_param'),
            ('score_pipeline', {'steps': ['pdf-text'], 'artifact': {'b64': '***'}}, 'invalid_param'),
            ('trap_list', {'id': 'T99'}, 'not_found'),
            ('oracle_trap_list', {'format': 'xml'}, 'invalid_param'),
        ]
        before_steps = pg.evaluate("window.__recipe.state().pipelines.map(p => p.steps.length)")
        bad = []
        for name, inp, code in cases:
            res = call(pg, name, inp)
            if not (isinstance(res, dict) and res.get('ok') is False and res['error'].get('code') == code and res['error'].get('message') and res['error'].get('hint')):
                bad.append((name, inp, res))
        ok(not bad, '%d invalid calls return {ok:false, error:{code, message, hint}} with the expected code' % len(cases), bad[:3])
        ok(pg.evaluate("window.__recipe.state().pipelines.map(p => p.steps.length)") == before_steps, 'a wrong pipelineId mutates nothing (no silent wrong-target success)')
        thrown = [n for n, inp, _ in cases if call_error(pg, n, inp) is not None]
        ok(not thrown, 'none of the invalid calls rejected (nothing thrown natively)', thrown)
        empty = call(pg, 'pipeline_build', {'steps': ['pdf-text']})
        removed = call(pg, 'pipeline_remove_step', {'pipelineId': empty['pipeline']['id'], 'position': 0})
        ok(removed['ok'] and removed['pipeline']['steps'] == [], 'pipeline_remove_step empties a one-step pipeline')
        ok(call(pg, 'pipeline_run', {'pipelineId': empty['pipeline']['id']})['error']['code'] == 'wrong_state', 'running an empty pipeline is wrong_state')
        ok(call(pg, 'pipeline_score', {'pipelineId': empty['pipeline']['id']})['error']['code'] == 'empty_result', 'scoring an empty pipeline is empty_result')

        # --- human in the loop: pipeline_delete exists only while a person arms it -----
        ok('pipeline_delete' not in own_names, 'pipeline_delete is not registered until a human arms it')
        gone = call_error(pg, 'pipeline_delete', {'pipelineId': empty['pipeline']['id']})
        ok(gone is not None and gone['name'] == 'UnknownError', 'calling the unarmed tool rejects with UnknownError', gone)
        tc = pg.evaluate('window.__recipe.state().toolChanges')
        pg.check('#chk-delete')
        pg.wait_for_function('(n) => window.__recipe.state().toolChanges > n', arg=tc, timeout=5000)
        ok('pipeline_delete' in [t['name'] for t in tools(pg)], 'ticking the box registers pipeline_delete (mc-toolchange fired)')
        pg.wait_for_function("document.getElementById('agent-tools').textContent.includes('pipeline_delete')", timeout=10000)
        listed = pg.evaluate("[...document.querySelectorAll('#agent-tools .tool-name')].map(e => e.textContent)")
        ok(len(listed) == 20 and 'score_pipeline' in listed, 'the agent-surface list shows all 20 tools including the new one', listed)
        cards_before = pg.locator('[data-test="pipeline-card"]').count()
        deleted = call(pg, 'pipeline_delete', {'pipelineId': empty['pipeline']['id']})
        pg.wait_for_function('(n) => document.querySelectorAll(\'[data-test="pipeline-card"]\').length === n - 1', arg=cards_before, timeout=5000)
        ok(deleted['ok'] and deleted['remaining'] == cards_before - 1, 'pipeline_delete removes the card from the canvas', deleted)
        ok(call(pg, 'pipeline_delete', {'pipelineId': 'p999'})['error']['code'] == 'not_found', 'deleting an unknown id is not_found')
        tc = pg.evaluate('window.__recipe.state().toolChanges')
        pg.uncheck('#chk-delete')
        pg.wait_for_function('(n) => window.__recipe.state().toolChanges > n', arg=tc, timeout=5000)
        ok('pipeline_delete' not in [t['name'] for t in tools(pg)], 'unticking aborts the signal and the tool disappears')
        ok(pg.evaluate("document.getElementById('pill-toolchange').textContent").startswith('toolchange ×'), 'the toolchange counter pill is live')

        ok(errors(pg) == [], 'no console or page errors', errors(pg))
    done('surface')


if __name__ == '__main__':
    main()
