/* src/pdf-fixtures.js — build a PDF from a raw content stream string.
 * Used by the ink-paradox fixture: a string positioned outside the page box, which a
 * content-stream extractor reads and a renderer never paints. */

import { concatBytes, latin1Encode } from './bytes.js';

export function writePdfRaw(...contentStreams) {
  const cs = contentStreams.map((c) => (typeof c === 'string' ? latin1Encode(c) : c));
  const n = cs.length;
  const fontNum = 3 + n * 2;
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = cs.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  cs.forEach((body, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push({ dict: `<< /Length ${body.length} >>`, stream: body });
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const parts = [];
  let pos = 0;
  const offsets = [];
  const push = (b) => { parts.push(b); pos += b.length; };
  push(latin1Encode('%PDF-1.4\n'));
  objects.forEach((obj, i) => {
    offsets.push(pos);
    if (typeof obj === 'string') push(latin1Encode(`${i + 1} 0 obj\n${obj}\nendobj\n`));
    else push(concatBytes([latin1Encode(`${i + 1} 0 obj\n${obj.dict}\nstream\n`), obj.stream, latin1Encode('\nendstream\nendobj\n')]));
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return concatBytes([...parts, latin1Encode(xref)]);
}
