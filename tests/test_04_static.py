"""Recipe — single-folder static mode: `python3 -m http.server` from apps/recipe, no kit server,
no injected origins. The oracle becomes a same-origin iframe; the spec makes its tools visible
by default (including the internal warm_cache), and the page says so.
"""
import os
import socket
import subprocess
import sys
import time
import urllib.request

from testkit import browser, call, done, errors, frame, new_page, ok, open_page, tools

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_for(url, seconds=15):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            if urllib.request.urlopen(url, timeout=2).status == 200:
                return True
        except Exception:
            time.sleep(0.1)
    return False


def main():
    port = free_port()
    base = 'http://127.0.0.1:%d' % port
    server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=APP,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ok(wait_for(base + '/kit/mc.js'), 'plain http.server serves the vendored kit from the app folder')
        with browser() as b:
            pg = new_page(b)
            open_page(pg, base=base, timeout=30000)
            ok(pg.evaluate('window.__bootError') is None, 'studio boots from a plain static server', pg.evaluate('window.__bootError'))
            ok(pg.evaluate('window.MC.isMulti') is False and pg.evaluate('window.__ORIGINS') is None, 'single-folder mode: MC.isMulti is false')
            ok(pg.evaluate("document.getElementById('scorer-frame').src").endswith('/scorer/index.html'), 'the oracle iframe loads from ./scorer/ on the same origin')
            scorer = frame(pg, 'scorer')
            ok(scorer is not None and scorer.evaluate('window.__appReady === true'), 'the same-origin scorer frame is ready')
            ok('single folder' in pg.inner_text('#pill-origin'), 'the origin pill says single folder', pg.inner_text('#pill-origin'))
            names = [t['name'] for t in tools(pg)]
            ok('score_pipeline' in names and 'trap_list' in names and 'warm_cache' in names, 'a same-origin frame\'s tools are visible by default, warm_cache included (spec)', names)
            ok(next(t['origin'] for t in tools(pg) if t['name'] == 'score_pipeline') == base, 'oracle tools now carry the studio origin')
            warmed = call(pg, 'warm_cache')
            ok(warmed.get('warmed') is True, 'the internal call is reachable same-origin (documented; hidden only across origins)', warmed)

            built = call(pg, 'pipeline_build', {'steps': ['docx-text', 'text-md'], 'inputType': 'docx', 'outputType': 'md'})
            pid = built['pipeline']['id']
            r = call(pg, 'pipeline_run', {'pipelineId': pid, 'fixture': 'docx-memo'})
            ok(r['ok'] and 'SENTINEL-ZIP-42' in r['artifact']['preview'], 'docx→md really runs from the static folder', r.get('artifact'))
            ok(r['verdict']['ok'] and r['verdict']['score'] == 100 and r['verdict']['oracle'] == 'scorer:' + base and 'same-origin' in r['verdict']['via'], 'the verdict still comes from the oracle frame, labelled same-origin', r['verdict'])
            bridged = call(pg, 'oracle_trap_list', {})
            ok(bridged['count'] == 15 and bridged['from'] == base, 'the bridge relays to the same-origin oracle', (bridged.get('count'), bridged.get('from')))
            pg.wait_for_function('(id) => document.querySelector(\'[data-pid="\' + id + \'"] .stars .num\')?.textContent === "100"', arg=pid, timeout=8000)
            ok(True, 'the card shows the oracle score')
            ok(errors(pg) == [], 'no console or page errors in static mode', errors(pg))
    finally:
        server.terminate()
        server.wait(timeout=10)
    done('static')


if __name__ == '__main__':
    main()
