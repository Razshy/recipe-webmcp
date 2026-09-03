/* src/office.js — the genuinely-REAL office transforms.
 * A .docx is a zip containing word/document.xml; a .xlsx is a zip containing
 * xl/worksheets/sheet1.xml + xl/sharedStrings.xml. Both are read with the app's own
 * zip reader, so "docx -> text" executes in the browser right now: no library, no server,
 * no simulation. Entity decoding is real too, which matters because a docx that stores
 * "AT&amp;T" and a reader that ignores entities disagree by exactly three characters. */

import { readZip, zipEntry, writeZip } from './zip.js';
import { textDecode, textEncode } from './bytes.js';
import { decodeEntities } from './entities.js';

/* ---------------- docx ---------------- */

export async function docxToText(bytes) {
  const entries = await readZip(bytes);
  const doc = await zipEntry(entries, 'word/document.xml');
  if (!doc) {
    const names = entries.map((e) => e.name);
    throw new Error('word/document.xml missing from the zip (saw: ' + names.slice(0, 6).join(', ') + ')');
  }
  return docxXmlToText(textDecode(doc), entries.length);
}

export function docxXmlToText(xml, entryCount = 1) {
  const paragraphs = [];
  let tables = 0;
  let runs = 0;
  const pRe = /<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  let m;
  while ((m = pRe.exec(xml))) {
    const chunk = m[0];
    if (/<w:tbl[ >]/.test(chunk)) tables++;
    const cells = [];
    const cellRe = /<w:tc[ >][\s\S]*?<\/w:tc>/g;
    let cm;
    while ((cm = cellRe.exec(chunk))) {
      cells.push(textOf(cm[0], (n) => { runs += n; }));
    }
    if (cells.length) paragraphs.push(cells.join('\t'));
    else paragraphs.push(textOf(chunk, (n) => { runs += n; }));
  }
  if (!paragraphs.length) {
    const only = textOf(xml, (n) => { runs += n; });
    if (only) paragraphs.push(only);
  }
  const text = paragraphs.join('\n').replace(/\n{3,}/g, '\n\n');
  return {
    text,
    stats: {
      entryCount,
      paragraphs: paragraphs.length,
      nonEmpty: paragraphs.filter((p) => p.trim()).length,
      tables,
      runs,
      chars: text.length,
    },
  };
}

function textOf(xml, countRuns) {
  let runs = 0;
  let out = '';
  const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = tRe.exec(xml))) { out += decodeEntities(m[1]); runs++; }
  // a w:tab is a real column separator in the source doc; keeping it as a tab keeps tables legible
  const tabCount = (xml.match(/<w:tab\s*\/>/g) || []).length;
  if (tabCount && !out.includes('\t')) out = out.split(' ').join('\t');
  if (countRuns) countRuns(runs);
  return out;
}

/** Build a real .docx around a text payload (used by fixtures + csv->docx style demos). */
export function textToDocx(text) {
  const paras = String(text).replace(/\r\n/g, '\n').split('\n')
    .map((line) => '<w:p><w:r><w:t xml:space="preserve">' +
      line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</w:t></w:r></w:p>')
    .join('');
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + paras + '<w:sectPr/></w:body></w:document>';
  return writeZip([
    { name: '[Content_Types].xml', data: textEncode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: textEncode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: textEncode(document) },
  ]);
}

/* ---------------- xlsx ---------------- */

const COL_RE = /^([A-Z]+)(\d+)$/;

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function xlsxToCsv(bytes) {
  const entries = await readZip(bytes);
  const sharedXml = await zipEntry(entries, 'xl/sharedStrings.xml');
  const shared = sharedXml ? parseSharedStrings(textDecode(sharedXml)) : [];
  const sheetNames = entries.filter((e) => /^xl\/worksheets\/.*\.xml$/.test(e.name)).map((e) => e.name).sort();
  const sheetKey = sheetNames.includes('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : sheetNames[0];
  if (!sheetKey) throw new Error('no worksheet part inside the xlsx zip');
  const sheet = textDecode(await zipEntry(entries, sheetKey));
  const { rows, numericLike, errorsFound } = parseSheet(sheet, shared);
  const width = rows.reduce((a, r) => Math.max(a, r.length), 0);
  const grid = rows.map((r) => {
    const out = new Array(width).fill('');
    r.forEach((v, i) => { out[i] = v; });
    return out;
  });
  return {
    csv: grid.map((r) => r.map(csvCell).join(',')).join('\r\n') + (grid.length ? '\r\n' : ''),
    stats: {
      sheetPart: sheetKey,
      sheetCount: sheetNames.length,
      rows: grid.length,
      cols: width,
      sharedStrings: shared.length,
      numericLike,
      errorsFound,
    },
  };
}

function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const parts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1]));
    out.push(parts.join(''));
  }
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  let numericLike = 0;
  let errorsFound = 0;
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs);
      const type = /t="([^"]+)"/.exec(attrs);
      const col = ref ? colIndex(ref[1]) : cells.length;
      let value = '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const isT = /<is[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(inner);
      if (type && type[1] === 's' && v) {
        const idx = Number(v[1]);
        value = Number.isFinite(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '#REF!' + idx;
      } else if (type && type[1] === 'inlineStr' && isT) {
        value = decodeEntities(isT[1]);
      } else if (type && type[1] === 'e' && v) {
        value = decodeEntities(v[1]);
        errorsFound++;
      } else if (type && type[1] === 'str' && v) {
        value = decodeEntities(v[1]);
      } else if (v) {
        value = decodeEntities(v[1]);
        if (value.trim() !== '' && Number.isFinite(Number(value))) numericLike++;
      }
      cells[col] = value;
    }
    rows.push(cells);
  }
  return { rows, numericLike, errorsFound };
}

export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Real CSV parsing (RFC4180 quoting, CRLF or LF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') { if (s[i + 1] === '\n') i++; row.push(field); field = ''; rows.push(row); row = []; continue; }
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const XLSX_CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
const XLSX_RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const XLSX_WB = '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
const XLSX_WB_RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

function colLetters(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export function csvToXlsx(csvText) {
  const rows = parseCsv(csvText);
  const body = rows.map((r, ri) =>
    '<row r="' + (ri + 1) + '">' + r.map((v, ci) => {
      const num = Number(v);
      const isNum = v !== '' && Number.isFinite(num);
      const ref = colLetters(ci) + (ri + 1);
      return isNum
        ? '<c r="' + ref + '"><v>' + v + '</v></c>'
        : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
          String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</t></is></c>';
    }).join('') + '</row>').join('');
  const sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>';
  const zip = writeZip([
    { name: '[Content_Types].xml', data: textEncode(XLSX_CT) },
    { name: '_rels/.rels', data: textEncode(XLSX_RELS) },
    { name: 'xl/workbook.xml', data: textEncode(XLSX_WB) },
    { name: 'xl/_rels/workbook.xml.rels', data: textEncode(XLSX_WB_RELS) },
    { name: 'xl/worksheets/sheet1.xml', data: textEncode(sheet) },
  ]);
  return { bytes: zip.bytes, declaredRatio: zip.declaredRatio, rows: rows.length };
}

/* ---------------- tabular text helpers ---------------- */

export function csvToMarkdown(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return { md: '_no rows_\n', rows: 0 };
  const width = rows.reduce((a, r) => Math.max(a, r.length), 0);
  const norm = rows.map((r) => {
    const out = [];
    for (let i = 0; i < width; i++) out.push(String(r[i] ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
    return out;
  });
  const head = norm[0];
  const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
  norm.slice(1).forEach((r) => lines.push('| ' + r.join(' | ') + ' |'));
  return { md: lines.join('\n') + '\n', rows: norm.length, cols: width };
}
