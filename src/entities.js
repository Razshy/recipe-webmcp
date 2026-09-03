/* src/entities.js — HTML/XML entity decoding, used by the docx/xlsx readers, the html->md
 * converter and the html->text step. */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ensp: '\u2002', emsp: '\u2003', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', deg: '\u00b0',
  plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7', laquo: '\u00ab', raquo: '\u00bb',
  sect: '\u00a7', para: '\u00b6', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
};

export function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str;
  return String(str).replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      try { return String.fromCodePoint(cp); } catch (e) { return m; }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : m;
  });
}
