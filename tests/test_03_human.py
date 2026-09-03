"""Recipe — the human path: a person with no agent builds, runs, scores, inspects and deletes
with clicks only. This file never touches the agent handle (it greps itself to prove it); it
reads the DOM and the read-only state snapshot.
"""
import os

from testkit import browser, done, errors, new_page, ok, open_page

AGENT_HANDLE = '__' + 'agent'


def state(pg):
    return pg.evaluate('window.__recipe.state()')


def main():
    with open(os.path.abspath(__file__)) as f:
        ok(AGENT_HANDLE not in f.read().replace("'__' + 'agent'", ''), 'this test drives the page by clicks only')
    with browser() as b:
        pg = new_page(b, viewport={'width': 1600, 'height': 1100})
        open_page(pg, timeout=30000)

        cards = pg.locator('[data-test="pipeline-card"]')
        ok(cards.count() == 2, 'two seeded recipes are on the canvas', cards.count())
        bad = cards.filter(has_text='Known-bad')
        good = cards.filter(has_text='Known-good')
        ok(bad.locator('.stars.dirty').count() == 1 and int(bad.locator('.num').inner_text()) < 40, 'the known-bad meter is red and below 40', bad.locator('.num').inner_text())
        ok(good.locator('.num').inner_text() == '100' and good.locator('.stars.dirty').count() == 0, 'the known-good meter reads a clean 100')
        ok(bad.locator('[data-test="step-trap"]').count() >= 2 and 'invisible text' in bad.locator('[data-test="step-trap"]').first.inner_text(), 'trap lessons are annotated inline on the offending steps')
        ok(bad.locator('.basis.plan').count() == 3, 'each seeded hit is labelled with its basis (plan)')
        ok(pg.locator('.badge.real').count() > 0 and pg.locator('.badge.sim').count() > 0, 'REAL and SIMULATED badges are both visible')
        engine = pg.inner_text('#pill-engine')
        ok(engine.startswith('WebMCP: native') or engine.startswith('WebMCP: kit shim'), 'the binding badge names native or shim', engine)
        ok('multi' in pg.inner_text('#pill-origin') and 'via fromOrigins' in pg.inner_text('#pill-oracle'), 'the origin and oracle pills report the multi-origin setup', pg.inner_text('#status-pills'))

        # --- start a recipe with the selects and one button ------------------------------
        pg.select_option('[data-test="input-type"]', 'docx')
        pg.select_option('[data-test="goal-type"]', 'md')
        ok(pg.evaluate("document.getElementById('fixture-id').value") == 'docx-memo', 'choosing an input selects its fixture')
        pg.click('[data-test="btn-build"]')
        pg.wait_for_function('window.__recipe.state().pipelines.length === 3', timeout=10000)
        fresh_id = state(pg)['pipelines'][2]['id']
        fresh = pg.locator('[data-pid="%s"]' % fresh_id)
        pg.wait_for_function('(id) => document.querySelector(\'[data-pid="\' + id + \'"] .stars .num\')', arg=fresh_id, timeout=10000)
        ok(fresh.locator('[data-test="step-row"]').count() == 2 and fresh.locator('.stars .num').inner_text() == '100', 'Start a recipe planned docx→md, built it and scored it 100')
        ok('planned: docx-text → text-md' in pg.inner_text('#plan-hint'), 'the plan hint shows the planned chain', pg.inner_text('#plan-hint'))

        # --- palette click appends, ✕ removes ------------------------------------------------
        pg.fill('[data-test="palette-filter"]', 'text-docx')
        ok(pg.locator('[data-palette]').count() == 1, 'the palette filter narrows to one transform')
        pg.click('[data-palette="text-docx"]')
        pg.wait_for_function('(id) => document.querySelectorAll(\'[data-pid="\' + id + \'"] [data-test="step-row"]\').length === 3', arg=fresh_id, timeout=8000)
        ok([s['toolId'] for s in state(pg)['pipelines'][2]['steps']] == ['docx-text', 'text-md', 'text-docx'], 'clicking a palette transform appended it to the selected recipe')
        ok(fresh.locator('.stars .lbl').inner_text() == 'UNSCORED', 'editing a recipe clears its score')
        pg.fill('[data-test="palette-filter"]', '')
        fresh.locator('[data-act="remove"]').last.click()
        pg.wait_for_function('(id) => document.querySelectorAll(\'[data-pid="\' + id + \'"] [data-test="step-row"]\').length === 2', arg=fresh_id, timeout=8000)
        ok(True, 'the ✕ button removed the last step')

        # --- run it on a fixture from the card ----------------------------------------------
        pg.select_option('[data-test="fixture-id"]', 'docx-memo')
        fresh.locator('[data-act="run"]').click()
        pg.wait_for_function('window.__recipe.state().runs === 1', timeout=15000)
        pg.wait_for_function('(id) => document.querySelector(\'[data-pid="\' + id + \'"]\')?.textContent?.includes("run: ok")', arg=fresh_id, timeout=8000)
        ok(fresh.locator('.step-io.run.ok').count() == 2, 'both steps show run: ok on the card')
        console = pg.inner_text('#console-lines')
        ok('B → ' in console and ('score ' + fresh_id) in console, 'the run console streamed byte counts and the re-score line', console[-300:])
        ok('last run' in pg.inner_text('#run-note') and 'docx-memo' in pg.inner_text('#run-note'), 'the run note names the fixture', pg.inner_text('#run-note'))
        ok('re-sniffed' in fresh.locator('.evidence').inner_text() or 'no artifact sent' in fresh.locator('.evidence').inner_text(), 'the card prints the evidence line after the re-score')

        # --- validate, propose, run-a-tool, oracle inspect ----------------------------------
        fresh.locator('[data-act="validate"]').click()
        pg.wait_for_function('document.querySelector(\'[data-test="call-out"]\').textContent.includes("pipeline_validate")', timeout=8000)
        ok('"valid": true' in pg.inner_text('[data-test="call-out"]'), 'Validate shows the validator result in the call panel')
        pg.click('[data-test="btn-bad"]')
        pg.wait_for_function('window.__recipe.state().pipelines.length === 4', timeout=10000)
        gap_card = pg.locator('[data-test="pipeline-card"]').nth(3)
        pg.wait_for_function('document.querySelectorAll(\'[data-test="pipeline-card"] .gapnum\').length >= 1', timeout=8000)
        ok(gap_card.locator('.gapnum').inner_text().startswith('+') and 'reports success' in gap_card.inner_text(), 'the proposer gap and rationale are printed on the card')
        pg.select_option('[data-test="call-tool"]', 'fixture_list')
        pg.fill('[data-test="call-input"]', '{"format": "detailed"}')
        pg.click('[data-test="btn-call"]')
        pg.wait_for_function('document.querySelector(\'[data-test="call-out"]\').textContent.includes("docx-memo")', timeout=8000)
        ok('SENTINEL-ZIP-42' in pg.inner_text('[data-test="call-out"]'), 'the run-a-tool panel executed fixture_list with the typed JSON input')
        pg.click('[data-test="btn-oracle-inspect"]')
        pg.wait_for_function('document.querySelector(\'[data-test="oracle-out"]\').textContent.includes("T12")', timeout=10000)
        out = pg.inner_text('[data-test="oracle-out"]')
        ok('"bridgedTo": "trap_list"' in out and 'scorer:' in out, 'the oracle panel shows the bridged catalogue reply', out[:200])
        rows = pg.locator('#invocations tr')
        ok(rows.count() >= 8 and 'pipeline_run' in pg.inner_text('#invocations') and 'oracle_trap_list' in pg.inner_text('#invocations'), 'the invocation log lists every call the buttons made', rows.count())
        rows.first.click()
        ok(pg.inner_text('[data-test="call-out"]').startswith('#'), 'clicking a log row shows its full input and output')
        surface = pg.inner_text('#agent-tools')
        ok('pipeline_run' in surface and 'oracle origin' in surface and 'read-only' in surface and 'Fixture name from fixture_list' in surface, 'the agent surface lists tools with origin, read-only chips and parameter descriptions')

        # --- arm deletion, delete with the card button, disarm --------------------------------
        ok('pipeline_delete' not in surface, 'pipeline_delete is absent until armed')
        tc = pg.inner_text('#pill-toolchange')
        pg.check('#chk-delete')
        pg.wait_for_function("document.getElementById('agent-tools').textContent.includes('pipeline_delete')", timeout=8000)
        ok('is registered' in pg.inner_text('#delete-note') and pg.inner_text('#pill-toolchange') != tc, 'ticking the box registers pipeline_delete and bumps the toolchange pill')
        fresh.locator('[data-act="delete"]').click()
        pg.wait_for_function('(id) => !document.querySelector(\'[data-pid="\' + id + \'"]\')', arg=fresh_id, timeout=8000)
        ok(fresh_id not in [p['id'] for p in state(pg)['pipelines']], 'the Delete button removed the card and the pipeline')
        pg.uncheck('#chk-delete')
        pg.wait_for_function("!document.getElementById('agent-tools').textContent.includes('pipeline_delete')", timeout=8000)
        ok('not registered' in pg.inner_text('#delete-note'), 'unticking the box unregisters pipeline_delete again')

        pg.click('[data-test="btn-clear-history"]')
        ok(state(pg)['runs'] == 0 and pg.inner_text('#console-lines') == '', 'clear history empties the run log and console')
        ok(state(pg)['errors'] == [], 'the page recorded no runtime errors', state(pg)['errors'])
        ok(errors(pg) == [], 'no console or page errors', errors(pg))
    done('human')


if __name__ == '__main__':
    main()
