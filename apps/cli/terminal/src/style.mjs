// The Sarion look: one palette (gold accent from the website), two themes, three colour depths, and a plain mode with no escape codes.
const HEX = {
  dark: {
    gold: '#D4AF37', dim: '#8B8B8B', user: '#E8E8E8', tool: '#6FB3D2', ok: '#5FD787', err: '#FF6B6B', warn: '#FFB454', info: '#82AAFF', code: '#E5C07B',
    keyword: '#C792EA', string: '#C3E88D', number: '#F78C6C', comment: '#6B7280', func: '#82AAFF', type: '#FFCB6B', attr: '#89DDFF', tag: '#F07178', literal: '#F78C6C', meta: '#7F8C98', add: '#5FD787', del: '#FF6B6B',
  },
  light: {
    gold: '#8A6D00', dim: '#6B6B6B', user: '#1A1A1A', tool: '#0F6A8A', ok: '#15803D', err: '#B91C1C', warn: '#B45309', info: '#1D4ED8', code: '#92400E',
    keyword: '#7C3AED', string: '#15803D', number: '#C2410C', comment: '#6B7280', func: '#1D4ED8', type: '#A16207', attr: '#0E7490', tag: '#BE123C', literal: '#C2410C', meta: '#52606D', add: '#15803D', del: '#B91C1C',
  },
};
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const to256 = ([r, g, b]) => {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : 232 + Math.round(((r - 8) / 247) * 24);
  const c = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
};
const to16 = ([r, g, b]) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 24) return max > 170 ? 97 : max > 90 ? 37 : 90;
  const hue = ((r === max ? (g - b) / (max - min) : g === max ? 2 + (b - r) / (max - min) : 4 + (r - g) / (max - min)) * 60 + 360) % 360;
  const base = hue < 20 || hue >= 340 ? 31 : hue < 70 ? 33 : hue < 170 ? 32 : hue < 200 ? 36 : hue < 270 ? 34 : 35;
  return max > 200 ? base + 60 : base;
};

/** Model and tool output goes to a real terminal: control characters (escape sequences that retitle the window, move the cursor or overwrite lines) are removed. Newline and tab stay. */
export const clean = (t) => String(t ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

const ANSI = /\u001b\[[0-9;]*m/g;
export const strip = (s) => String(s).replace(ANSI, '');
const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]/u;
/** Printed width of a string: escape codes are zero, wide (CJK, emoji) characters are two. */
export const width = (s) => { let w = 0; for (const ch of strip(s)) w += wide.test(ch) ? 2 : 1; return w; };
/** Cuts a string to a printed width, keeping escape codes intact and closing them. */
export function clip(s, max) {
  if (width(s) <= max) return s;
  let out = '', w = 0, i = 0; const str = String(s);
  while (i < str.length && w < max - 1) {
    const m = /^\u001b\[[0-9;]*m/.exec(str.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(str.codePointAt(i)); const cw = wide.test(ch) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch; w += cw; i += ch.length;
  }
  return out + '…\u001b[0m';
}

export function makeStyle(term) {
  const on = term.color;
  const pal = HEX[term.theme] || HEX.dark;
  const open = (code) => `\u001b[${code}m`;
  const colour = (hex) => {
    if (!on) return (t) => String(t);
    const c = rgb(hex);
    const seq = term.depth >= 24 ? `38;2;${c[0]};${c[1]};${c[2]}` : term.depth >= 8 ? `38;5;${to256(c)}` : String(to16(c));
    return (t) => `${open(seq)}${t}\u001b[39m`;
  };
  const attr = (n, off) => (on ? (t) => `${open(n)}${t}${open(off)}` : (t) => String(t));
  const s = {
    on, term, pal,
    bold: attr(1, 22), italic: attr(3, 23), underline: attr(4, 24), inverse: attr(7, 27),
    fg: colour,
    unicode: term.unicode,
  };
  for (const k of ['gold', 'dim', 'user', 'tool', 'ok', 'err', 'warn', 'info', 'code', 'keyword', 'string', 'number', 'comment', 'func', 'type', 'attr', 'tag', 'literal', 'meta', 'add', 'del']) s[k] = colour(pal[k]);
  s.badge = (text, kind = 'warn') => (on ? `${open(7)}${s[kind](` ${text} `)}${open(27)}` : `[${text}]`);
  s.glyph = term.unicode
    ? { dot: '●', bullet: '•', bar: '│', tl: '╭', bl: '╰', tr: '╮', br: '╯', h: '─', arrow: '›', check: '✓', cross: '✗', diamond: '◆', fill: '━', empty: '─', ellipsis: '…', spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], vbar: '│', todoOpen: '○', todoActive: '◐', todoDone: '●', up: '↑', down: '↓', cross2: '┼', lt: '├', rt: '┤', dh: '─', warn: '!' }
    : { dot: '*', bullet: '-', bar: '|', tl: '+', bl: '+', tr: '+', br: '+', h: '-', arrow: '>', check: 'ok', cross: 'x', diamond: '#', fill: '#', empty: '.', ellipsis: '...', spin: ['|', '/', '-', '\\'], vbar: '|', todoOpen: '[ ]', todoActive: '[~]', todoDone: '[x]', up: '^', down: 'v', cross2: '+', lt: '+', rt: '+', dh: '-', warn: '!' };
  return s;
}
