// Streaming Markdown for the terminal. Text arrives in small pieces and is drawn as it arrives: paragraphs word by word, lists, headings, quotes and tables as
// soon as the line shows what it is, fenced code line by line with syntax colours. Plain mode (no colour) passes the text through untouched.
import { clean, strip, width, clip } from './style.mjs';
import { highlightLines } from './highlight.mjs';

const MAX_INCREMENTAL_LINES = 300;

/** Draws one line of inline Markdown (bold, italic, code) to a string. Used for table cells and by the stream itself. */
export function inlineToString(text, style, base = (t) => t) {
  let out = '';
  const r = new Inline(style, (t) => { out += t; }, base); r.push(String(text)); r.end();
  return out;
}

class Inline {
  constructor(style, write, base) { this.style = style; this.write = write; this.base = base; this.reset(); }
  reset() { this.bold = false; this.italic = false; this.code = false; this.hold = ''; this.run = ''; this.last = ' '; }
  painter() {
    const s = this.style; const base = this.base;
    if (this.code) return (t) => s.code(t);
    let f = base; if (this.bold) { const g = f; f = (t) => s.bold(g(t)); } if (this.italic) { const g = f; f = (t) => s.italic(g(t)); }
    return f;
  }
  flushRun() { if (this.run) { this.write(this.painter()(this.run)); this.run = ''; } }
  emit(ch) { this.run += ch; this.last = ch; }
  toggle(kind) { this.flushRun(); this[kind] = !this[kind]; }
  char(ch) {
    if (this.code) { if (ch === '`') this.toggle('code'); else this.emit(ch); return; }
    if (this.hold === '*') {
      this.hold = '';
      if (ch === '*') { this.toggle('bold'); return; }
      if (this.italic) { if (this.last !== ' ') this.toggle('italic'); else this.emit('*'); }
      else if (ch !== ' ') this.toggle('italic'); else this.emit('*');
    }
    if (ch === '*') { this.hold = '*'; return; }
    if (ch === '`') { this.toggle('code'); return; }
    this.emit(ch);
  }
  push(text) { for (const ch of text) this.char(ch); this.flushRun(); }
  /** End of the line: a lone held asterisk is literal, and open styles do not run into the next line. */
  end() { if (this.hold) { this.emit(this.hold); this.hold = ''; } this.flushRun(); this.reset(); }
}

export class MarkdownStream {
  constructor({ style, write, columns = 80 }) {
    this.s = style; this.write = write; this.columns = columns;
    this.mode = 'bol'; this.lead = ''; this.blank = 0; this.any = false;
    this.inline = null; this.fence = null; this.table = [];
  }
  out(t) { if (t) { this.write(t); } }
  newline() { this.out('\n'); this.any = true; this.blank = 0; }

  push(text) {
    const t = clean(text).replace(/\r/g, '');
    if (!this.s.on) { if (t) { this.write(t); this.any = true; } return; }
    for (const ch of t) this.char(ch);
    if (this.inline) this.inline.flushRun();
  }
  end() {
    if (!this.s.on) return;
    if (this.mode === 'bol' && this.lead) this.decide(true);
    if (this.mode === 'inline') { this.inline.end(); this.newline(); this.mode = 'bol'; }
    if (this.mode === 'fence-info') this.openFence();
    if (this.mode === 'fence') { if (this.fence.cur) this.fenceLine(this.fence.cur); this.closeFence(); }
    this.flushTable(); this.mode = 'bol'; this.lead = '';
  }

  char(ch) {
    switch (this.mode) {
      case 'bol': if (ch === '\n') { this.decide(true); } else { this.lead += ch; this.decide(false); } return;
      case 'inline': if (ch === '\n') { this.inline.end(); this.newline(); this.mode = 'bol'; this.lead = ''; } else this.inline.char(ch); return;
      case 'fence-info': if (ch === '\n') this.openFence(); else this.fence.info += ch; return;
      case 'fence': if (ch === '\n') { const line = this.fence.cur; this.fence.cur = ''; this.fenceLine(line); } else this.fence.cur += ch; return;
      case 'table': if (ch === '\n') { this.table.push(this.fence.cur); this.fence.cur = ''; this.mode = 'bol'; this.lead = ''; } else this.fence.cur += ch; return;
    }
  }

  startInline(prefix, base) {
    this.out(prefix || '');
    this.inline = new Inline(this.s, (x) => this.out(x), base || ((x) => x));
    this.mode = 'inline'; this.any = true; this.blank = 0;
  }

  /** The line's first characters show what it is. Returns once decided; waits for more characters when it cannot tell yet. */
  decide(final) {
    const m = /^( *|\t*)(.*)$/.exec(this.lead); const indent = m[1].length; const rest = m[2];
    const s = this.s, g = s.glyph;
    if (!final && rest === '') return; // still in the indent
    if (rest === '' && final) { this.flushTable(); if (this.any && this.blank < 1) { this.out('\n'); this.blank++; } this.lead = ''; return; }
    const fenceMark = /^(`{3,}|~{3,})/.exec(rest);
    if (fenceMark) { this.flushTable(); this.fence = { marker: fenceMark[1][0], info: rest.slice(fenceMark[1].length), cur: '', lines: [], indent }; this.mode = final ? 'bol' : 'fence-info'; if (final) this.openFence(); this.lead = ''; return; }
    if (!final && /^(`{1,2}|~{1,2})$/.test(rest)) return;
    if (/^#{1,6}$/.test(rest) && !final) return;
    const h = /^(#{1,6}) /.exec(rest);
    if (h) { this.flushTable(); const lv = h[1].length; this.gap(); const base = lv === 1 ? (t) => s.bold(s.gold(t)) : lv === 2 ? (t) => s.bold(t) : (t) => s.bold(s.dim(t)); this.startInline('', base); this.inline.push(rest.slice(h[0].length)); this.lead = ''; return; }
    if (!final && /^[-*_]{1,3}$/.test(rest)) return; // bullet, bold marker or horizontal rule: not yet known
    if (final && /^([-*_])\1{2,}\s*$/.test(rest)) { this.flushTable(); this.gap(); this.out(s.dim(g.h.repeat(Math.min(this.columns - 2, 60)))); this.newline(); this.lead = ''; return; }
    const b = /^[-*+] /.exec(rest);
    if (b) { this.flushTable(); const pad = ' '.repeat(2 + Math.floor(indent / 2) * 2); this.startInline(`${pad}${s.gold(g.bullet)} `); this.inline.push(rest.slice(2)); this.lead = ''; return; }
    if (!final && /^\d{1,3}[.)]?$/.test(rest)) return;
    const o = /^(\d{1,3})[.)] /.exec(rest);
    if (o) { this.flushTable(); const pad = ' '.repeat(2 + Math.floor(indent / 2) * 2); this.startInline(`${pad}${s.gold(o[1] + '.')} `); this.inline.push(rest.slice(o[0].length)); this.lead = ''; return; }
    if (rest === '>' && !final) return;
    if (rest[0] === '>') { this.flushTable(); const body = rest.replace(/^> ?/, ''); this.startInline(`  ${s.dim(g.bar)} `, (t) => s.dim(s.italic(t))); this.inline.push(body); this.lead = ''; return; }
    if (rest[0] === '|') { this.mode = final ? 'bol' : 'table'; this.fence = { cur: rest }; if (final) { this.table.push(rest); } this.lead = ''; return; }
    // a plain paragraph line
    this.flushTable();
    this.startInline('', (t) => t); this.inline.push(this.lead); this.lead = '';
    if (final) { this.inline.end(); this.newline(); this.mode = 'bol'; }
  }

  gap() { if (this.any && this.blank < 1) { this.out('\n'); this.blank++; } }

  openFence() {
    const f = this.fence; const s = this.s, g = s.glyph;
    f.lang = f.info.trim().split(/\s+/)[0] || '';
    this.gap();
    this.out(`  ${s.dim(g.tl + g.h)} ${f.lang ? s.dim(f.lang) : ''}`.replace(/ +$/, '') + '\n');
    this.mode = 'fence'; this.any = true; this.blank = 0;
  }
  fenceLine(line) {
    const f = this.fence;
    if (new RegExp(`^\\s*${f.marker === '`' ? '`' : '~'}{3,}\\s*$`).test(line)) { this.closeFence(true); return; }
    const text = f.indent ? line.replace(new RegExp(`^ {0,${f.indent}}`), '') : line;
    f.lines.push(text);
    const lang = f.lang;
    const painted = f.lines.length <= MAX_INCREMENTAL_LINES ? highlightLines(f.lines, lang, this.s) : highlightLines([text], lang, this.s);
    this.out(`  ${this.s.dim(this.s.glyph.bar)} ${painted[painted.length - 1]}\n`);
  }
  closeFence(fromLine = false) {
    if (this.mode !== 'fence' && !fromLine) return;
    this.out(`  ${this.s.dim(this.s.glyph.bl + this.s.glyph.h)}\n`);
    this.mode = 'bol'; this.lead = ''; this.fence = null; this.any = true; this.blank = 0;
  }

  flushTable() {
    if (!this.table.length) return;
    const rows = this.table.map((r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
    this.table = [];
    const isSep = (r) => r.every((c) => /^:?-{2,}:?$/.test(c));
    const head = rows[0]; const body = rows.slice(1).filter((r) => !isSep(r));
    const s = this.s, g = s.glyph;
    const cols = Math.max(...rows.map((r) => r.length));
    const cells = (r, bold) => Array.from({ length: cols }, (_, i) => { const t = inlineToString(r[i] ?? '', s, bold ? (x) => s.bold(x) : (x) => x); return t; });
    const all = [cells(head, true), ...body.map((r) => cells(r, false))];
    const widths = Array.from({ length: cols }, (_, i) => Math.max(1, ...all.map((r) => width(r[i]))));
    const budget = this.columns - 2 - (cols + 1) * 3 + 2;
    while (widths.reduce((a, b) => a + b, 0) > budget && Math.max(...widths) > 6) { const i = widths.indexOf(Math.max(...widths)); widths[i]--; }
    const row = (r) => `  ${s.dim(g.vbar)} ${r.map((c, i) => { const cc = clip(c, widths[i]); return cc + ' '.repeat(Math.max(0, widths[i] - width(cc))); }).join(` ${s.dim(g.vbar)} `)} ${s.dim(g.vbar)}`;
    const sep = `  ${s.dim(g.lt + widths.map((w) => g.h.repeat(w + 2)).join(g.cross2) + g.rt)}`;
    this.gap();
    this.out(row(all[0]) + '\n');
    this.out(sep + '\n');
    for (const r of all.slice(1)) this.out(row(r) + '\n');
    this.any = true; this.blank = 0;
  }
}
