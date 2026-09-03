"""Recipe — REAL execution: pipelines that actually process bytes in the browser.

The fixtures are generated HERE, in Python, and uploaded through fixture_upload, so a pass
means the studio's own zip reader / PDF writer / PDF interpreter agreed with an independent
producer (Python's zipfile) — not just with itself.
"""
import base64
import io
import json
import os
import zipfile

from playwright.sync_api import sync_playwright

BASE = os.environ['BASE_URL']
ORIG = json.loads(os.environ['ORIGINS_JSON'])

DOCX_SENTINEL = 'SENTINEL-ZIP-42'
PDF_SENTINEL = 'SENTINEL-PDF-7'

CHECKS = []


def check(name, cond, detail=''):
    CHECKS.append(name)
    assert cond, 'FAILED: %s — %s' % (name, detail)


def call(page, tool, payload=None):
    raw = page.evaluate('(a) => window.__agent.call(%s, a)' % json.dumps(tool), json.dumps(payload or {}))
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return raw
    return raw


def docx_b64(compression=zipfile.ZIP_DEFLATED):
    """A genuine .docx: zip container, word/document.xml, sentinel inside a <w:t> run."""
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        '<w:p><w:r><w:t>Document pipeline review</w:t></w:r></w:p>'
        '<w:p><w:r><w:t xml:space="preserve">Reference: __SENTINEL__ - recoverable only by opening the '
        'zip, inflating the part and decoding the run.</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>Entities: AT&amp;T and &lt;legacy&gt;</w:t></w:r></w:p>'
        '</w:body></w:document>'
    ).replace('__SENTINEL__', DOCX_SENTINEL)
    content_types = ('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument'
                     '.wordprocessingml.document.main+xml"/></Types>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships/>')
        z.writestr('word/document.xml', document)
    return base64.b64encode(buf.getvalue()).decode()


def xlsx_b64():
    shared = ['region', 'units', 'north', '77']
    ss = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">' + \
        ''.join('<si><t>%s</t></si>' % s for s in shared) + '</sst>'
    sheet = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
             '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>direct</t></is></c></row>'
             '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>77</v></c><c r="C2" t="e"><v>#REF!</v></c></row>'
             '</sheetData></worksheet>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/sharedStrings.xml', ss)
        z.writestr('xl/worksheets/sheet1.xml', sheet)
    return base64.b64encode(buf.getvalue()).decode()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors, console_errors = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)

        page.goto(BASE + '/index.html')
        page.wait_for_function('window.__ready === true', timeout=20000)

        # ---- fixture_upload: Python-generated docx (deflate) + stored zip --------------
        up = call(page, 'fixture_upload', {'name': 'py-docx-deflated', 'b64': docx_b64(), 'type': 'docx'})
        check('fixture_upload accepts a Python-generated docx', up['ok'] and up['bytes'] > 100, up)
        check('uploaded docx is magic-sniffed as a zip package', 'ZIP' in str(up['sniffed']['magic']), up['sniffed'])
        up2 = call(page, 'fixture_upload', {'name': 'py-docx-stored', 'b64': docx_b64(zipfile.ZIP_STORED), 'type': 'docx'})
        check('stored-method docx also accepted', up2['ok'], up2)

        # ---- REAL: docx → text recovers the sentinel from a real zip -------------------
        for fixture in ('py-docx-deflated', 'py-docx-stored'):
            b = call(page, 'pipeline_build', {'steps': ['docx-text'], 'inputType': 'docx', 'outputType': 'txt', 'name': 'docx→text'})
            pid = b['pipeline']['id']
            run = call(page, 'pipeline_run', {'pipelineId': pid, 'fixture': fixture})
            check('docx→text runs (%s)' % fixture, run['ok'], run.get('steps'))
            step = run['steps'][0]
            check('docx reader reports the zip entry count (%s)' % fixture, step['meta']['entries'] == 3, step['meta'])
            check('docx→text recovers %s (%s)' % (DOCX_SENTINEL, fixture), DOCX_SENTINEL in (run['artifact']['preview'] or ''), run['artifact'])
            check('docx reader decoded XML entities', 'AT&T' in run['artifact']['preview'], run['artifact']['preview'])
            check('step reports byte accounting', step['bytesIn'] > 0 and step['bytesOut'] > 0, step)

        # ---- REAL: text → pdf → text round trip through our own writer + reader --------
        b = call(page, 'pipeline_build', {'steps': ['text-pdf', 'pdf-text'], 'inputType': 'txt', 'outputType': 'txt'})
        pid = b['pipeline']['id']
        v = call(page, 'pipeline_validate', {'pipelineId': pid})
        check('text→pdf→text validates', v['ok'], v)
        run = call(page, 'pipeline_run', {'pipelineId': pid, 'fixture': 'txt-sentinel'})
        check('text→pdf→text runs', run['ok'], run.get('steps'))
        check('round trip recovers %s' % PDF_SENTINEL, PDF_SENTINEL in (run['artifact']['preview'] or ''), run['artifact'])
        pdf_step = run['steps'][0]
        check('pdf writer emits a real PDF (magic)', 'PDF' in str(pdf_step['magic']), pdf_step)
        check('pdf writer declares only the face it carries', pdf_step['meta']['embeddedFonts'] == ['Helvetica (Type1, not embedded)'], pdf_step['meta'])
        check('pdf reader counted the Tj strings', run['steps'][1]['meta']['strings'] >= 1, run['steps'][1]['meta'])

        # ---- REAL: png → pdf → png, and the dimension-true identity round trip ---------
        b = call(page, 'pipeline_build', {'steps': ['ocr', 'text-pdf', 'pdf-rasterize'], 'inputType': 'png', 'outputType': 'png'})
        pid = b['pipeline']['id']
        run = call(page, 'pipeline_run', {'pipelineId': pid, 'fixture': 'png-scan'})
        check('png→pdf→png runs', run['ok'], run.get('steps'))
        final = run['artifact']
        check('png→pdf→png yields a decodable PNG', final.get('magicType') == 'png', final)
        check('rendered png has real dimensions', final['dims'] == {'width': 612, 'height': 792}, final['dims'])
        run_again = call(page, 'pipeline_run', {'pipelineId': pid, 'fixture': 'png-scan'})
        check('simulated OCR is deterministic across runs',
              run_again['steps'][0]['bytesOut'] == run['steps'][0]['bytesOut'], (run['steps'][0], run_again['steps'][0]))
        check('OCR step announces itself as simulated', run['steps'][0]['mode'] == 'simulated', run['steps'][0])

        b = call(page, 'pipeline_build', {'steps': ['png-decode', 'png-encode'], 'inputType': 'png', 'outputType': 'png'})
        pid2 = b['pipeline']['id']
        run2 = call(page, 'pipeline_run', {'pipelineId': pid2, 'fixture': 'png-scan'})
        check('png→rgba→png round trip preserves dimensions',
              run2['artifact']['dims'] == {'width': 120, 'height': 90}, run2['artifact'])
        check('decode reports the stride budget the file size hides',
              run2['steps'][0]['meta']['strideBytes'] == 120 * 90 * 4, run2['steps'][0]['meta'])

        # ---- the ink paradox: a string that exists but was never painted --------------
        b = call(page, 'pipeline_build', {'steps': ['pdf-rasterize', 'ocr'], 'inputType': 'pdf', 'outputType': 'txt'})
        pid3 = b['pipeline']['id']
        run3 = call(page, 'pipeline_run', {'pipelineId': pid3, 'fixture': 'pdf-offcanvas'})
        check('off-canvas pdf runs', run3['ok'], run3.get('steps'))
        check('rasteriser measured zero ink', run3['steps'][0]['meta']['drawOps'] == 0, run3['steps'][0]['meta'])
        check('OCR flagged the ink paradox', 'inkParadox' in run3['steps'][1]['notes'], run3['steps'][1]['notes'])
        score = call(page, 'pipeline_score', {'pipelineId': pid3})
        check('runtime evidence re-scores the pipeline (T01 fired from the run)',
              'T01' in [h['trapId'] for h in score['hits']], score)

        # ---- the quality flag that does nothing ---------------------------------------
        b = call(page, 'pipeline_build', {'steps': [{'toolId': 'png-quality', 'params': {'quality': 99}}], 'inputType': 'png', 'outputType': 'png'})
        pid4 = b['pipeline']['id']
        run4 = call(page, 'pipeline_run', {'pipelineId': pid4, 'fixture': 'png-scan'})
        m = run4['steps'][0]['meta']
        check('quality=99 byte length equals quality=1 byte length', m['bytesWithQuality'] == m['bytesWithoutQuality'], m)
        check('the app reports the parameter was ignored', m['qualityHonored'] is False, m)
        check('T06 fires once the run proves it', 'T06' in [h['trapId'] for h in call(page, 'pipeline_score', {'pipelineId': pid4})['hits']], run4['notes'])

        # ---- exit-0-empty-output class -------------------------------------------------
        b = call(page, 'pipeline_build', {'steps': [{'toolId': 'docx-pdf-soffice', 'params': {'empty': True}}], 'inputType': 'docx', 'outputType': 'pdf'})
        pid5 = b['pipeline']['id']
        run5 = call(page, 'pipeline_run', {'pipelineId': pid5, 'fixture': 'docx-memo'})
        check('soffice-like step exits 0', run5['steps'][0]['meta']['exitCode'] == 0, run5['steps'][0])
        check('…and writes nothing', run5['steps'][0]['bytesOut'] == 0, run5['steps'][0])
        sc5 = call(page, 'pipeline_score', {'pipelineId': pid5})
        check('T04 (exit-0-empty-output) fires from runtime evidence', 'T04' in [h['trapId'] for h in sc5['hits']], sc5['hits'])

        # ---- xlsx → csv from a Python-built workbook ----------------------------------
        call(page, 'fixture_upload', {'name': 'py-xlsx', 'b64': xlsx_b64(), 'type': 'xlsx'})
        b = call(page, 'pipeline_build', {'steps': ['xlsx-csv'], 'inputType': 'xlsx', 'outputType': 'csv'})
        pid6 = b['pipeline']['id']
        run6 = call(page, 'pipeline_run', {'pipelineId': pid6, 'fixture': 'py-xlsx'})
        check('xlsx→csv runs on a Python-built workbook', run6['ok'], run6.get('steps'))
        csv_out = run6['artifact']['preview'] or ''
        check('shared strings resolved by index', 'region' in csv_out and 'north' in csv_out, csv_out)
        check('inline strings read directly', 'direct' in csv_out, csv_out)
        check('numeric cell preserved', '77' in csv_out, csv_out)
        check('spreadsheet error cells are counted, not hidden', run6['steps'][0]['meta']['errorsFound'] == 1, run6['steps'][0]['meta'])

        # ---- zip pack / unpack round trip ---------------------------------------------
        b = call(page, 'pipeline_build', {'steps': ['zip-pack', 'zip-unpack'], 'inputType': 'files', 'outputType': 'files'})
        pid7 = b['pipeline']['id']
        run7 = call(page, 'pipeline_run', {'pipelineId': pid7, 'fixture': 'zip-parts'})
        check('zip pack→unpack round trip runs', run7['ok'], run7.get('steps'))
        names = [f['name'] for f in (run7['artifact'].get('files') or [])]
        check('both parts survive the round trip', names == ['notes.md', 'data.csv'], names)
        check('store-method zip declares an honest ratio', run7['steps'][0]['meta']['declaredRatio'] <= 1.1, run7['steps'][0]['meta'])

        # ---- markdown → html → markdown ----------------------------------------------
        b = call(page, 'pipeline_build', {'steps': ['md-html', 'html-text'], 'inputType': 'md', 'outputType': 'txt'})
        pid8 = b['pipeline']['id']
        run8 = call(page, 'pipeline_run', {'pipelineId': pid8, 'fixture': 'md-notes'})
        check('md→html→text runs', run8['ok'], run8.get('steps'))
        check('converter output survives tag stripping', 'Validate magic bytes after every convert' in run8['artifact']['preview'], run8['artifact'])
        check('run_history recorded every run', call(page, 'run_history', {})['count'] >= 10, call(page, 'run_history', {})['count'])

        # ---- a step that cannot run honestly reports failure, not a fake answer -------
        b = call(page, 'pipeline_build', {'steps': ['xlsx-csv'], 'inputType': 'xlsx', 'outputType': 'csv'})
        run9 = call(page, 'pipeline_run', {'pipelineId': b['pipeline']['id'], 'fixture': 'png-scan'})
        check('feeding a png to the xlsx reader fails loudly', run9['ok'] is False and run9['steps'][0]['ok'] is False, run9['steps'])

        check('zero page errors', not errors, errors)
        check('zero console errors', not console_errors, console_errors)
        browser.close()
        print('RECIPE-EXEC OK — %d assertions' % len(CHECKS))


if __name__ == '__main__':
    main()
