"""Recipe — the human path: a person with no agent at all can build, score and run.

Also asserts the honesty UI: badges, star meters that turn red on trap hits, inline trap
annotations on the offending step, and the live tool list reacting to registration changes.
"""
import json
import os

from playwright.sync_api import sync_playwright

BASE = os.environ['BASE_URL']
ORIG = json.loads(os.environ['ORIGINS_JSON'])

CHECKS = []


def check(name, cond, detail=''):
    CHECKS.append(name)
    assert cond, 'FAILED: %s — %s' % (name, detail)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1600, 'height': 1100})
        errors, console_errors = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)

        page.goto(BASE + '/index.html')
        page.wait_for_function('window.__ready === true', timeout=20000)
        check('boot error surfaced', page.evaluate('window.__bootError') in (None, ''), page.evaluate('window.__bootError'))

        # ---- the two seeded demo recipes are on the canvas, already scored --------------
        cards = page.locator('[data-test="pipeline-card"]')
        check('seeded recipes rendered as index cards', cards.count() == 2, cards.count())
        bad_card = page.locator('[data-test="pipeline-card"]').filter(has_text='Known-bad')
        check('known-bad meter is red and below 40',
              bad_card.locator('.stars.dirty').count() == 1 and
              int(bad_card.locator('.num').inner_text()) < 40,
              bad_card.locator('.num').inner_text())
        good_card = page.locator('[data-test="pipeline-card"]').filter(has_text='Known-good')
        check('known-good meter reads a clean 100', good_card.locator('.num').inner_text() == '100',
              good_card.locator('.num').inner_text())
        check('no red stars on the good card', good_card.locator('.stars.dirty').count() == 0)
        check('star rating rendered', '★' in bad_card.locator('.glyphs').inner_text())
        check('trap hits annotated inline on the offending step',
              bad_card.locator('[data-test="step-trap"]').count() >= 2,
              bad_card.locator('[data-test="step-trap"]').count())
        check('the annotation carries the lesson text',
              'invisible text' in bad_card.locator('[data-test="step-trap"]').first.inner_text())
        check('REAL and SIMULATED badges both visible',
              page.locator('.badge.real').count() > 0 and page.locator('.badge.sim').count() > 0)
        check('scorer iframe points at the scorer origin', page.evaluate("""(o) => {
            const f = document.getElementById('scorer-frame');
            return !!f && f.src.indexOf(o) === 0;
        }""", ORIG['scorer']))
        scorer_frame = pg_frame = page.frame(name='scorer')
        check('scorer frame reachable as a separate origin realm', scorer_frame is not None)
        check('scorer frame reports its own readiness', scorer_frame.evaluate('window.__appReady === true'))
        check('scorer frame is served from the scorer port',
              scorer_frame.evaluate('window.__MC_SELF') == ORIG['scorer'],
              scorer_frame.evaluate('window.__MC_SELF'))
        check('scorer frame painted the catalogue', 'T12' in scorer_frame.inner_text('body'))
        check('multi-origin mode detected', page.evaluate('window.MC.isMulti') is True or
              page.evaluate('window.__ORIGINS') is None)

        # ---- human builds a pipeline with clicks only ----------------------------------
        page.select_option('[data-test="input-type"]', 'docx')
        page.select_option('[data-test="goal-type"]', 'md')
        page.click('[data-test="btn-build"]')
        page.wait_for_function('window.__recipe.store.pipelines.length === 3', timeout=8000)
        check('building a recipe added a card', page.locator('[data-test="pipeline-card"]').count() == 3)
        fresh_id = page.evaluate('window.__recipe.store.pipelines[2].id')
        fresh = page.locator('[data-pid="%s"]' % fresh_id)
        check('planner produced a docx→md chain', fresh.locator('[data-test="step-row"]').count() == 2,
              fresh.locator('[data-test="step-row"]').count())

        # append a step by clicking a palette card
        page.fill('[data-test="palette-filter"]', 'text-docx')
        page.click('[data-palette="text-docx"]')
        page.wait_for_function('window.__recipe.store.pipelines[2].steps.length === 3', timeout=8000)
        check('clicking a palette transform appended it',
              page.evaluate('window.__recipe.store.pipelines[2].steps.map(s=>s.toolId)') == ['docx-text', 'text-md', 'text-docx'])
        page.fill('[data-test="palette-filter"]', '')

        # run it on a fixture through the card button (no agent handle involved)
        page.select_option('[data-test="fixture-id"]', 'docx-memo')
        fresh.locator('[data-act="run"]').click()
        page.wait_for_function('window.__recipe.store.runs.length > 0', timeout=15000)
        check('run console streamed per-step lines', page.locator('#console-lines .line').count() >= 4,
              page.locator('#console-lines .line').count())
        check('console reported byte counts', 'B →' in page.locator('#console-lines').inner_text())
        check('card shows the run outcome per step', 'run: ok' in fresh.inner_text(), fresh.inner_text()[:400])
        check('run note updated', 'last run' in page.inner_text('#run-note'), page.inner_text('#run-note'))

        # ---- demo buttons ---------------------------------------------------------------
        page.click('[data-test="btn-bad"]')
        page.wait_for_function('window.__recipe.store.pipelines.length === 4', timeout=10000)
        page.wait_for_function('document.querySelectorAll(\'[data-test="pipeline-card"]\').length === 4', timeout=8000)
        gap_card = page.locator('[data-test="pipeline-card"]').nth(-1)
        check('proposer gap printed on the card', 'gap' in gap_card.inner_text(), gap_card.inner_text()[:600])
        check('self-score exceeds the oracle score', gap_card.locator('.gapnum').inner_text().startswith('+'),
              gap_card.locator('.gapnum').inner_text())
        check('proposer rationale shown on its card', 'Every step reports success' in gap_card.inner_text() or
              'reports success' in gap_card.inner_text(), gap_card.inner_text()[:400])

        page.select_option('[data-test="call-tool"]', 'fixture_list')
        page.fill('[data-test="call-input"]', '{}')
        page.click('[data-test="btn-call"]')
        page.wait_for_function('document.querySelector(\'[data-test="call-out"]\').textContent.includes("fixtures")', timeout=8000)
        check('manual tool call panel renders JSON', 'docx-memo' in page.inner_text('[data-test="call-out"]'))

        page.click('[data-test="btn-oracle-inspect"]')
        page.wait_for_function('document.querySelector(\'[data-test="oracle-out"]\').textContent.includes("T12")', timeout=10000)
        check('oracle catalogue panel shows the trap engine reply', 'scorer:' in page.inner_text('[data-test="oracle-out"]'))
        check('oracle call counter advanced in the pill', 'scored' in page.inner_text('#pill-oracle'),
              page.inner_text('#pill-oracle'))

        # ---- dynamic registration is visible in the UI ---------------------------------
        tools_before = page.locator('[data-test="agent-tools"] li').count()
        page.evaluate('window.__before = document.querySelectorAll(\'[data-test="agent-tools"] li\').length')
        page.uncheck('#chk-probe')
        page.wait_for_function('document.querySelectorAll(\'[data-test="agent-tools"] li\').length < window.__before', timeout=8000)
        tools_after = page.locator('[data-test="agent-tools"] li').count()
        check('unregistering a tool removes it from the live list', tools_after == tools_before - 1, (tools_before, tools_after))
        page.check('#chk-probe')
        page.wait_for_function('document.querySelectorAll(\'[data-test="agent-tools"] li\').length === %d' % tools_before, timeout=8000)
        check('re-registering brings it back', page.locator('[data-test="agent-tools"] li').count() == tools_before)

        # ---- select + delete through the UI --------------------------------------------
        fresh.locator('[data-act="delete"]').click()
        page.wait_for_function('!window.__recipe.store.pipelines.some(p => p.id === %s)' % json.dumps(fresh_id), timeout=8000)
        check('delete button removed the card', fresh_id not in page.evaluate('window.__recipe.store.pipelines.map(p=>p.id)'))
        check('status pills report the runtime', 'kit shim' in page.inner_text('#pill-engine') or
              'native' in page.inner_text('#pill-engine'), page.inner_text('#pill-engine'))

        check('zero page errors', not errors, errors)
        check('zero console errors', not console_errors, console_errors)
        browser.close()
        print('RECIPE-UI OK — %d assertions' % len(CHECKS))


if __name__ == '__main__':
    main()
