"""Recipe — REAL execution and honest verdicts.

Fixtures are generated HERE in Python (zipfile, zlib), so a pass means the studio's zip reader,
PDF inflater and OOXML parsers agree with an independent producer. Every assertion is about the
DOM or the returned bytes, and the oracle's verdict is compared before and after a run so the
"measured" / "claimed" / "plan" labels are proven, not just present.
"""
import base64
import io
import zipfile
import zlib

from testkit import ORIGINS, browser, call, done, errors, new_page, ok, open_page, tools

SCORER = ORIGINS['scorer']
DOCX_SENTINEL = 'SENTINEL-ZIP-42'
PDF_SENTINEL = 'SENTINEL-PDF-7'
FLATE_SENTINEL = 'FLATE-SENTINEL-31'


def docx_b64(compression=zipfile.ZIP_DEFLATED):
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        '<w:p><w:r><w:t>Document pipeline review</w:t></w:r></w:p>'
        '<w:p><w:r><w:t xml:space="preserve">Reference: %s - recoverable only by opening the zip.</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>Entities: AT&amp;T and &lt;legacy&gt;</w:t></w:r></w:p>'
        '</w:body></w:document>' % DOCX_SENTINEL
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
        z.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships/>')
        z.writestr('word/document.xml', document)
    return base64.b64encode(buf.getvalue()).decode()


def xlsx_b64():
    ss = ('<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
          + ''.join('<si><t>%s</t></si>' % s for s in ['region', 'units', 'north']) + '</sst>')
    sheet = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
             '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>direct</t></is></c></row>'
             '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>77</v></c><c r="C2" t="e"><v>#REF!</v></c></row>'
             '</sheetData></worksheet>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/sharedStrings.xml', ss)
        z.writestr('xl/worksheets/sheet1.xml', sheet)
    return base64.b64encode(buf.getvalue()).decode()


def flate_pdf_b64(text):
    """A PDF whose content stream is FlateDecode (zlib-wrapped, as every real producer emits)."""
    cs = ('BT /F1 12 Tf 72 700 Td (%s) Tj ET' % text).encode('latin-1')
    comp = zlib.compress(cs)
    objs = [b'<< /Type /Catalog /Pages 2 0 R >>',
            b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
            b'<< /Length %d /Filter /FlateDecode >>\nstream\n' % len(comp) + comp + b'\nendstream']
    out = b'%PDF-1.4\n'
    offs = []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += b'%d 0 obj\n' % (i + 1) + o + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    for o in offs:
        out += b'%010d 00000 n \n' % o
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    return base64.b64encode(out).decode()


def build(pg, steps, input_type, output_type, **kw):
    r = call(pg, 'pipeline_build', dict({'steps': steps, 'inputType': input_type, 'outputType': output_type}, **kw))
    assert r['ok'], r
    return r['pipeline']['id']


def run(pg, pid, fixture, **kw):
    return call(pg, 'pipeline_run', dict({'pipelineId': pid, 'fixture': fixture}, **kw))


def hit_ids(verdict):
    return sorted(h['trapId'] for h in verdict['hits'])


def basis(verdict, trap):
    return next((h['basis'] for h in verdict['hits'] if h['trapId'] == trap), None)


def card_score(pg, pid):
    return int(pg.locator('[data-pid="%s"] .stars .num' % pid).inner_text())


def main():
    with browser() as b:
        pg = new_page(b)
        open_page(pg, timeout=30000)
        tools(pg, [SCORER])  # discover the oracle so score_pipeline/trap_list resolve by name too

        # --- docx from Python (deflated + stored) ------------------------------------------
        up = call(pg, 'fixture_upload', {'name': 'py-docx-deflated', 'b64': docx_b64(), 'type': 'docx'})
        ok(up['ok'] and up['sniffed']['type'] == 'zip' and up['mismatch'] is False, 'uploaded docx is sniffed as a zip package', up)
        call(pg, 'fixture_upload', {'name': 'py-docx-stored', 'b64': docx_b64(zipfile.ZIP_STORED), 'type': 'docx'})
        pg.wait_for_function("document.getElementById('fixture-id').textContent.includes('py-docx-stored')", timeout=5000)
        ok(True, 'uploaded fixtures appear in the fixture select')
        for fixture in ('py-docx-deflated', 'py-docx-stored'):
            pid = build(pg, ['docx-text'], 'docx', 'txt')
            r = run(pg, pid, fixture, format='detailed')
            ok(r['ok'] and r['steps'][0]['meta']['entries'] == 3, 'docx→text opened the %s zip (3 entries)' % fixture, r['steps'])
            ok(DOCX_SENTINEL in r['artifact']['preview'] and 'AT&T' in r['artifact']['preview'], 'docx→text recovered the sentinel and decoded entities (%s)' % fixture, r['artifact'])
        ok(r['verdict']['ok'] and r['verdict']['score'] == 100 and r['verdict']['evidence']['artifactSeen'] is None, 'text artifacts are scored 100 with nothing to re-sniff', r['verdict'])

        # --- FlateDecode PDF from Python: zlib streams really inflate -----------------------
        call(pg, 'fixture_upload', {'name': 'py-flate-pdf', 'b64': flate_pdf_b64(FLATE_SENTINEL), 'type': 'pdf'})
        pid = build(pg, ['pdf-text'], 'pdf', 'txt')
        r = run(pg, pid, 'py-flate-pdf', format='detailed')
        ok(r['ok'] and FLATE_SENTINEL in r['artifact']['preview'], 'pdf→text inflates a zlib FlateDecode stream and reads the sentinel', r['artifact'])
        ok(r['steps'][0]['meta']['strings'] == 1 and r['steps'][0]['meta']['streamsFailed'] == 0 and r['notes'] == {}, 'a real PDF yields strings, no failed streams, no notes', r['steps'][0]['meta'])

        # --- text uploads run (no ReferenceError), untyped text defaults to txt, overwrite replaces
        up = call(pg, 'fixture_upload', {'name': 'py-text', 'text': 'Uploaded text FIXTURE-TXT-9 for a real run.'})
        ok(up['ok'] and up['declaredType'] == 'txt', 'a text upload without a type is declared txt', up)
        pid = build(pg, ['text-md'], 'txt', 'md')
        r = run(pg, pid, 'py-text')
        ok(r['ok'] and 'FIXTURE-TXT-9' in r['artifact']['preview'], 'an uploaded text fixture runs through a text transform', r)
        call(pg, 'fixture_upload', {'name': 'txt-sentinel', 'text': 'REPLACED-CONTENT-5', 'type': 'txt'})
        pid = build(pg, ['text-pdf', 'pdf-text'], 'txt', 'txt')
        r = run(pg, pid, 'txt-sentinel', format='detailed')
        ok(r['ok'] and 'REPLACED-CONTENT-5' in r['artifact']['preview'] and PDF_SENTINEL not in r['artifact']['preview'], 're-uploading a fixture replaces its content (no stale text)', r['artifact'])
        ok('PDF' in r['steps'][0]['magic'] and r['steps'][0]['meta']['embeddedFonts'] == ['Helvetica (Type1, not embedded)'], 'text→pdf writes a real PDF and declares only the face it carries', r['steps'][0])

        # --- the mislabeled scan: PNG bytes named .pdf ----------------------------------------
        pid = build(pg, ['pdf-text'], 'pdf', 'txt')
        r = run(pg, pid, 'png-bytes-named-pdf')
        ok(r['ok'] is False and r['steps'][0]['ok'] is False and 'PNG' in r['steps'][0]['error'], 'pdf→text refuses PNG bytes loudly instead of reporting an empty success', r['steps'][0])
        ok('magicMismatch' in r['notes'], 'the magic mismatch observed before the failure survives it', r['notes'])
        ok(basis(r['verdict'], 'T13') == 'measured' and r['verdict']['evidence']['artifactSeen']['magic'] == 'PNG', 'the oracle re-sniffed the bytes itself: T13 basis "measured"', r['verdict'])
        pg.wait_for_function('(id) => document.querySelector(\'[data-pid="\' + id + \'"]\')?.textContent?.includes("FAILED")', arg=pid, timeout=5000)
        ok(pg.locator('[data-pid="%s"] .step-io.run.err' % pid).count() == 1, 'the card shows the failed step in the error style')

        # --- score before vs after a run: plan-only, then measured ----------------------------
        pid = build(pg, ['rename-avif'], 'png', 'png')
        before = call(pg, 'pipeline_score', {'pipelineId': pid})
        ok(hit_ids(before) == ['T02', 'T03'] and before['score'] == 70, 'before running, only plan-level traps fire on rename-avif', before)
        ok(card_score(pg, pid) == 70, 'the card meter shows the oracle score')
        r = run(pg, pid, 'png-scan')
        after = r['verdict']
        ok(hit_ids(after) == ['T02', 'T03', 'T13'] and after['score'] == 40, 'after running, T13 fires from the artifact bytes', after)
        ok(basis(after, 'T13') == 'measured' and after['evidence']['artifactSeen']['declaredType'] == 'avif', 'the oracle measured the declared-AVIF/actual-PNG mismatch itself', after['evidence'])
        pg.wait_for_function('(id) => document.querySelector(\'[data-pid="\' + id + \'"] .stars .num\')?.textContent === "40"', arg=pid, timeout=5000)
        ok(pg.locator('[data-pid="%s"] .basis.measured' % pid).count() == 1, 'the card shows the "measured" basis chip')
        ok('re-sniffed' in pg.locator('[data-pid="%s"] .evidence' % pid).inner_text(), 'the card prints the evidence line with the re-sniff', pg.locator('[data-pid="%s"] .evidence' % pid).inner_text())

        # --- claimed evidence is labelled claimed --------------------------------------------
        good = next(p['id'] for p in call(pg, 'pipeline_list')['pipelines'] if p['name'].startswith('Known-good'))
        claimed = call(pg, 'pipeline_score', {'pipelineId': good, 'claims': {'magicMismatch': True}})
        ok(claimed['score'] == 70 and basis(claimed, 'T13') == 'claimed' and claimed['evidence']['claimed'] == ['magicMismatch'], 'a hit resting only on caller claims is labelled basis "claimed"', claimed)
        pg.wait_for_function('(id) => !!document.querySelector(\'[data-pid="\' + id + \'"] .basis.claimed\')', arg=good, timeout=5000)
        ok(True, 'the card shows the "claimed" chip')
        ok(call(pg, 'pipeline_score', {'pipelineId': good})['score'] == 100, 'without claims the known-good chain scores 100 again')

        # --- exit-0-empty-output: the oracle sees 0 bytes ------------------------------------
        pid = build(pg, [{'toolId': 'docx-pdf-soffice', 'params': {'empty': True}}], 'docx', 'pdf')
        r = run(pg, pid, 'docx-memo', format='detailed')
        ok(r['ok'] and r['steps'][0]['meta']['exitCode'] == 0 and r['steps'][0]['bytesOut'] == 0, 'the soffice-like step exits 0 and writes nothing', r['steps'][0])
        ok('emptyOutput' in r['verdict']['evidence']['measured'] and r['verdict']['evidence']['artifactSeen']['bytes'] == 0 and 'T04' in hit_ids(r['verdict']), 'the oracle measured the 0-byte artifact itself', r['verdict']['evidence'])

        # --- the ink paradox ---------------------------------------------------------------
        pid = build(pg, ['pdf-rasterize', 'ocr'], 'pdf', 'txt')
        r = run(pg, pid, 'pdf-offcanvas', format='detailed')
        ok(r['ok'] and r['steps'][0]['meta']['drawOps'] == 0 and r['steps'][0]['meta']['inkPixels'] == 0, 'the rasteriser measured zero ink on the off-canvas page', r['steps'][0]['meta'])
        ok('inkParadox' in r['steps'][1]['notes'] and r['steps'][1]['mode'] == 'simulated', 'simulated OCR flags that it read a page nobody painted', r['steps'][1])
        ok('T01' in hit_ids(r['verdict']) and 'T09' in hit_ids(r['verdict']), 'the verdict carries T01 and T09 for the blank scan', r['verdict'])

        # --- the quality knob that does nothing ----------------------------------------------
        pid = build(pg, [{'toolId': 'png-quality', 'params': {'quality': 99}}], 'png', 'png')
        r = run(pg, pid, 'png-scan', format='detailed')
        m = r['steps'][0]['meta']
        ok(m['bytesWithQuality'] == m['bytesWithoutQuality'] and m['qualityHonored'] is False and 'qualityIgnored' in r['notes'], 'quality=99 produced byte-identical output and the step says so', m)

        # --- xlsx from Python -------------------------------------------------------------
        call(pg, 'fixture_upload', {'name': 'py-xlsx', 'b64': xlsx_b64(), 'type': 'xlsx'})
        pid = build(pg, ['xlsx-csv'], 'xlsx', 'csv')
        r = run(pg, pid, 'py-xlsx', format='detailed')
        csv_out = r['artifact']['preview']
        ok(r['ok'] and 'region' in csv_out and 'north' in csv_out and 'direct' in csv_out and '77' in csv_out, 'xlsx→csv resolves shared, inline and numeric cells', csv_out)
        ok(r['steps'][0]['meta']['errorsFound'] == 1 and 'cellErrors' in r['notes'] and 'T05' in hit_ids(r['verdict']), 'a #REF! cell is counted, noted, and scored', r['notes'])
        r = run(pg, pid, 'png-scan')
        ok(r['ok'] is False and 'ZIP' in r['steps'][0]['error'] and basis(r['verdict'], 'T13') == 'measured', 'feeding a png to the xlsx reader fails loudly and the oracle measures the mismatch', r['steps'][0])

        # --- zip round trip + markdown tables -----------------------------------------------
        pid = build(pg, ['zip-pack', 'zip-unpack'], 'files', 'files')
        r = run(pg, pid, 'zip-parts', format='detailed')
        ok(r['ok'] and [f['name'] for f in r['artifact']['files']] == ['notes.md', 'data.csv'] and r['steps'][0]['meta']['declaredRatio'] <= 1.0, 'files→zip→files round trip keeps both parts with an honest ratio', r['artifact'])
        call(pg, 'fixture_upload', {'name': 'py-table', 'text': '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n', 'type': 'md'})
        pid = build(pg, ['md-html'], 'md', 'html')
        html = run(pg, pid, 'py-table')['artifact']['preview']
        ok(html.count('<table>') == 1 and html.count('</table>') == 1 and '<thead>' in html and '<tbody>' in html and '<td>3</td>' in html and '<th>a</th>' in html, 'pipe tables become one closed table with a header row and body cells', html)
        pid = build(pg, ['md-html', 'html-text'], 'md', 'txt')
        r = run(pg, pid, 'md-notes')
        ok(r['ok'] and 'Validate magic bytes after every convert' in r['artifact']['preview'], 'md→html→text survives tag stripping', r['artifact'])

        # --- planning, listing, editing, proposing, seeding --------------------------------
        plan = call(pg, 'pipeline_plan', {'inputType': 'docx', 'outputType': 'md'})
        ok(plan['ok'] and plan['steps'] == ['docx-text', 'text-md'] and plan['chain'] == ['docx', 'txt', 'md'], 'pipeline_plan finds the docx→md chain', plan)
        listing = call(pg, 'pipeline_list')
        ok(listing['count'] == pg.locator('[data-test="pipeline-card"]').count() and listing['selected'] == pid, 'pipeline_list matches the cards on the canvas and the selection', (listing['count'], listing['selected']))
        pid = build(pg, ['pdf-text', 'summarize'], 'pdf', 'txt', name='edit me')
        added = call(pg, 'pipeline_add_step', {'pipelineId': pid, 'toolId': 'pdf-rasterize', 'position': 0})
        ok([s['toolId'] for s in added['pipeline']['steps']] == ['pdf-rasterize', 'pdf-text', 'summarize'], 'position 0 inserts at the front', added)
        pg.wait_for_function('(id) => document.querySelectorAll(\'[data-pid="\' + id + \'"] [data-test="step-row"]\').length === 3', arg=pid, timeout=5000)
        v = call(pg, 'pipeline_validate', {'pipelineId': pid})
        ok(v['valid'] is False and v['errors'][0]['kind'] == 'missing-connector' and 'insert' in v['errors'][0]['fix'], 'the validator names the missing connector and an executable fix', v)
        removed = call(pg, 'pipeline_remove_step', {'pipelineId': pid, 'position': 0})
        ok(removed['removed'] == 'pdf-rasterize' and call(pg, 'pipeline_validate', {'pipelineId': pid})['valid'] is True, 'removing the front step makes the chain sound again')
        ok(any(w['kind'] == 'simulated' for w in call(pg, 'pipeline_validate', {'pipelineId': pid})['warnings']), 'simulated steps surface as warnings')
        unknown = build(pg, ['not-a-real-transform'], 'txt', 'txt')
        ok(call(pg, 'pipeline_validate', {'pipelineId': unknown})['errors'][0]['kind'] == 'unknown-tool', 'an unknown toolId is reported by the validator, not swallowed')
        prop = call(pg, 'pipeline_propose', {'goal': 'summarize the scanned pdf'})
        ok(prop['ok'] and prop['gap'] >= 30 and prop['pipeline']['id'], 'the scripted proposer over-rates the scan chain and the oracle gap is reported', (prop.get('selfScore'), prop.get('oracleScore')))
        pg.wait_for_function('(id) => document.querySelector(\'[data-pid="\' + id + \'"] .gapnum\')', arg=prop['pipeline']['id'], timeout=5000)
        ok(pg.locator('[data-pid="%s"] .gapnum' % prop['pipeline']['id']).inner_text().startswith('+'), 'the gap is printed on the card')
        shadow = call(pg, 'pipeline_propose', {'goal': 'get the tables out of a spreadsheet as csv', 'build': False})
        ok(shadow['ok'] and shadow['pipeline'] is None and shadow['gap'] <= 8, 'build:false scores the proposal without creating a card', shadow)
        cards = pg.locator('[data-test="pipeline-card"]').count()
        seeded = call(pg, 'pipeline_seed_bad')
        ok(seeded['score'] == 10 and sorted(h['trapId'] for h in seeded['hits']) == ['T01', 'T09', 'T12'] and seeded['oracle'].startswith('scorer:'), 'pipeline_seed_bad scores 10 with T01/T09/T12 from the oracle', seeded)
        pg.wait_for_function('(n) => document.querySelectorAll(\'[data-test="pipeline-card"]\').length === n + 1', arg=cards, timeout=5000)
        ok(True, 'the seeded card appears on the canvas')
        hist = call(pg, 'run_history', {'limit': 3})
        ok(hist['count'] >= 12 and len(hist['runs']) == 3 and hist['runs'][0]['fixture'] == 'md-notes', 'run_history counts every run and honours limit', (hist['count'], len(hist['runs'])))
        explain = call(pg, 'step_explain', {'toolId': 'ocr'})
        ok(explain['mode'] == 'simulated' and [t['id'] for t in explain['traps']] == ['T01', 'T09'] and all(t['lesson'] for t in explain['traps']), 'step_explain badges OCR simulated with the oracle\'s lessons', explain)
        cat = call(pg, 'catalog_list', {'mode': 'simulated'})
        ok(cat['count'] == 7 and all(t['mode'] == 'simulated' for t in cat['transforms']), 'catalog_list filters the 7 simulated transforms', cat['count'])
        full = call(pg, 'catalog_list')
        ok(full['count'] == 26 and full['real'] == 19, 'catalog_list lists 26 transforms, 19 real', (full['count'], full['real']))

        ok(errors(pg) == [], 'no console or page errors', errors(pg))
    done('pipelines')


if __name__ == '__main__':
    main()
