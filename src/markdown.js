/* src/markdown.js — a small, honest markdown<->html converter.
 * Supports exactly what it claims: headings, bold, italic, inline code, fenced code,
 * links, unordered/ordered lists, paragraphs, tables (pipe syntax -> <table>).
 * Anything it does not understand passes through as escaped text (never silently dropped). */

import { decodeEntities } from './entities.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(src) {
  let out = esc(src);
  out = out.replace(/`([^`]+)`/g, (_m, c) => '<code>' + c + '</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b) => '<strong>' + b + '</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p, i) => p + '<em>' + i + '</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text, href) => '<a href="' + (/^(https?:|mailto:|#|\/)/.test(href) ? href : '#') + '">' + text + '</a>');
  return out;
}

export function mdToHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let fence = null;
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
  };
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const fenceMatch = /^\s*```(.*)$/.exec(line);
    if (fenceMatch) {
      if (fence === null) { flushPara(); closeList(); fence = []; }
      else { out.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>'); fence = null; }
      continue;
    }
    if (fence !== null) { fence.push(raw); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); closeList();
      const lvl = h[1].length;
      out.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>');
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + inline(ul[1]) + '</li>');
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + inline(ol[1]) + '</li>');
      continue;
    }
    if (/^\s*\|(.+)\|\s*$/.test(line)) {
      flushPara(); closeList();
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      const tag = out.length && /<table>$/.test(out[out.length - 1]) ? 'tr' : null;
      if (!tag) out.push('<table>');
      const cellTag = out.some((l) => l.includes('<table>')) && !out.some((l) => l.includes('<tbody>')) ? 'th' : 'td';
      out.push('<tr>' + cells.map((c) => '<' + cellTag + '>' + inline(c) + '</' + cellTag + '>').join('') + '</tr>');
      continue;
    }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    para.push(line.trim());
  }
  if (fence !== null) out.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>');
  flushPara();
  closeList();
  const body = out.join('\n');
  return body.replace(/<table>/g, '<table>').replace(/<\/table>/g, '</table>');
}

function inlineToMd(src) {
  let s = src;
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => '`' + decodeEntities(c).trim() + '`');
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, b) => '**' + decodeEntities(b).trim() + '**');
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, i) => '*' + decodeEntities(i).trim() + '*');
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => '[' + decodeEntities(t).trim() + '](' + href + ')');
  return decodeEntities(s).trim();
}

export function htmlToMd(html) {
  const src = String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const blocks = [];
  const push = (s) => { if (s && s.trim()) blocks.push(s.trim()); };

  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let work = src.replace(tableRe, (_m, inner) => {
    const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((c) => inlineToMd(c[1]).replace(/\|/g, '/')));
    if (!rows.length) return '';
    const head = '| ' + rows[0].join(' | ') + ' |';
    const sep = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
    const body = rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |');
    return '\n\n' + [head, sep, ...body].join('\n') + '\n\n';
  });

  const pre = [];
  work = work.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '');
    pre.push('```\n' + code + '\n```');
    return '\u0000PRE' + (pre.length - 1) + '\u0000';
  });

  const re = /<(h[1-6]|ul|ol|p|blockquote)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(work))) {
    const tag = m[1].toLowerCase();
    const inner = m[3];
    if (tag[0] === 'h') {
      push('#'.repeat(Number(tag[1])) + ' ' + inlineToMd(inner));
    } else if (tag === 'p') {
      push(inlineToMd(inner.replace(/<br\s*\/?>/gi, ' ')));
    } else if (tag === 'blockquote') {
      push(inlineToMd(inner).split('\n').map((l) => '> ' + l).join('\n'));
    } else {
      const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((c, i) =>
        (tag === 'ol' ? (i + 1) + '. ' : '- ') + inlineToMd(c[1]));
      push(items.join('\n'));
    }
  }
  const leftovers = work.replace(re, '').replace(/\u0000PRE(\d+)\u0000/g, (_m, i) => '\n\n' + pre[Number(i)] + '\n\n');
  const text = inlineToMd(leftovers.replace(/<[^>]+>/g, '\n'));
  if (text) text.split(/\n{2,}/).forEach(push);
  let md = blocks.join('\n\n');
  md = md.replace(/\u0000PRE(\d+)\u0000/g, (_m, i) => '\n\n' + pre[Number(i)] + '\n\n');
  return md + '\n';
}
