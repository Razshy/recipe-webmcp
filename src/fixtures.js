/* src/fixtures.js — the seeded fixtures, all built in this tab by the app's own writers
 * (zip, docx, xlsx, PDF, PNG via canvas). Each carries a note saying what it proves. */

import { textToDocx, csvToXlsx } from './office.js';
import { writePdf } from './pdf.js';
import { writePdfRaw } from './pdf-fixtures.js';
import { mdToHtml } from './markdown.js';
import { writeZip } from './zip.js';
import { bytesFromB64, textEncode } from './bytes.js';
import { putFixture } from './state.js';

function pngBytes(w, h, painter) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  painter(ctx, w, h);
  return bytesFromB64(canvas.toDataURL('image/png').split(',')[1]);
}

export function buildFixtures() {
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
    '- [a converter that renamed instead of converting](https://example.test/rename)',
    '',
    '## Follow up',
    '',
    'Validate magic bytes after every convert.',
    '',
    '| step | verdict |',
    '| --- | --- |',
    '| soffice | exit 0, 0 bytes |',
    '| quantize | quality ignored |',
    '',
    '```',
    'pipeline = input -> steps -> output',
    '```',
  ].join('\n');

  const pngScan = pngBytes(120, 90, (ctx, w) => {
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
  const pdf = writePdf(memoText, { rects: [{ x: 54, y: 60, w: 18, h: 18 }] });
  const sentinelText = 'Round-trip probe SENTINEL-PDF-7 lives in a Tj operator and must come back out.';
  const pdfSentinel = writePdf(sentinelText, { rects: [{ x: 420, y: 700, w: 30, h: 30 }] });
  const pdfOffcanvas = writePdfRaw('BT /F1 10 Tf 4800 4600 Td (HIDDEN-STRING-99 was never painted) Tj ET');
  const xlsx = csvToXlsx(csv);
  const parts = [
    { name: 'notes.md', data: textEncode('# inside a zip\n\nsecond part\n') },
    { name: 'data.csv', data: textEncode('a,b\n1,2\n') },
  ];
  const zip = writeZip(parts);

  const seeds = [
    { name: 'docx-memo', type: 'docx', bytes: docx.bytes, note: 'real OOXML package: our writer, store-method zip, sentinel SENTINEL-ZIP-42 inside word/document.xml' },
    { name: 'pdf-doc', type: 'pdf', bytes: pdf, note: 'minimal single-font PDF (Tj operators) plus one painted rect' },
    { name: 'pdf-sentinel', type: 'pdf', bytes: pdfSentinel, note: 'round-trip probe carrying SENTINEL-PDF-7' },
    { name: 'pdf-offcanvas', type: 'pdf', bytes: pdfOffcanvas, note: 'the ink paradox: a string at 4800,4600 — readable, never painted' },
    { name: 'png-scan', type: 'png', bytes: pngScan, note: '120x90 synthetic scan: bars and a ruled table box, no text layer at all' },
    { name: 'xlsx-sales', type: 'xlsx', bytes: xlsx.bytes, note: 'real xlsx package: sheet1 with inline strings and numeric cells' },
    { name: 'zip-packed', type: 'zip', bytes: zip.bytes, note: 'store-method zip written by this app — hand it to zip-unpack' },
    { name: 'zip-parts', kind: 'files', files: parts.map((f) => ({ name: f.name, data: f.data, bytes: f.data.length })), note: 'two parts awaiting a store-method pack' },
    { name: 'txt-plain', type: 'txt', text: memoText, note: 'the memo as plain text' },
    { name: 'txt-sentinel', type: 'txt', text: sentinelText + '\n', note: 'input side of the pdf round trip' },
    { name: 'md-notes', type: 'md', text: md, note: 'markdown with headings, lists, a link, a pipe table and a fence' },
    { name: 'html-notes', type: 'html', text: mdToHtml(md), note: 'the markdown fixture converted to html by the app’s own converter' },
    { name: 'csv-sales', type: 'csv', text: csv, note: 'five-row sales table, unquoted numerics' },
    { name: 'doc-legacy', type: 'doc', bytes: docx.bytes, note: 'a .docx renamed to .doc — extension dispatch takes the wrong branch' },
    { name: 'png-bytes-named-pdf', type: 'pdf', bytes: pngScan, note: 'PNG bytes wearing a .pdf name; sniff it before trusting the label' },
  ];
  for (const f of seeds) putFixture(f);
}
