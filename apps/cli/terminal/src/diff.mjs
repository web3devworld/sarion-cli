// A readable diff for the permission prompt and the tool line: line numbers, two lines of context, + and - counts, long lines cut to the terminal width.
import { clip, width } from './style.mjs';

const CONTEXT = 2;
const DP_LIMIT = 2_000_000;

/** Line-level diff: ops of {t: ' ' | '-' | '+', a, b, text}. Common start and end are trimmed first; a very large change falls back to replace-all. */
export function lineDiff(a, b) {
  let lo = 0; while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length; while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(lo, ea), B = b.slice(lo, eb); const ops = [];
  for (let i = 0; i < lo; i++) ops.push({ t: ' ', a: i, b: i, text: a[i] });
  if (A.length * B.length > DP_LIMIT) {
    A.forEach((text, i) => ops.push({ t: '-', a: lo + i, text })); B.forEach((text, j) => ops.push({ t: '+', b: lo + j, text }));
  } else {
    const n = A.length, m = B.length; const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ t: ' ', a: lo + i, b: lo + j, text: A[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ t: '-', a: lo + i, text: A[i] }); i++; }
      else { ops.push({ t: '+', b: lo + j, text: B[j] }); j++; }
    }
    for (; i < n; i++) ops.push({ t: '-', a: lo + i, text: A[i] });
    for (; j < m; j++) ops.push({ t: '+', b: lo + j, text: B[j] });
  }
  for (let k = 0; k < a.length - ea; k++) ops.push({ t: ' ', a: ea + k, b: eb + k, text: a[ea + k] });
  return ops;
}

const split = (t) => { const l = String(t).split('\n'); if (l.length && l[l.length - 1] === '') l.pop(); return l; };

/** { lines (painted, ready to print), added, removed, plain (unpainted text for logs and tests) } for a plan from editPlan(). */
export function renderPlan(plan, style, columns = 80, maxLines = 24) {
  const s = style;
  if (!plan || plan.error) return { lines: [], added: 0, removed: 0, plain: '' };
  const after = split(plan.after), isNew = plan.before === null;
  const ops = isNew ? after.map((text, j) => ({ t: '+', b: j, text })) : lineDiff(split(plan.before), after);
  const added = ops.filter((o) => o.t === '+').length, removed = ops.filter((o) => o.t === '-').length;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== ' ') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true; });
  const numW = String(Math.max(1, ...ops.map((o) => (o.b ?? o.a) + 1))).length;
  const room = Math.max(20, columns - numW - 8);
  const lines = [], plain = []; let shown = 0, skippedChanged = 0, gap = false;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (!keep[i]) { gap = true; continue; }
    if (shown >= maxLines) { if (o.t !== ' ') skippedChanged++; continue; }
    if (gap && lines.length) { lines.push(s.dim(`${' '.repeat(numW)}   ${s.glyph.ellipsis}`)); plain.push('...'); }
    gap = false; shown++;
    const num = String((o.t === '-' ? o.a : o.b ?? o.a) + 1).padStart(numW);
    const text = clip(o.text.replace(/\t/g, '  '), room);
    if (o.t === '+') { lines.push(`${s.dim(num)} ${s.add('+')} ${s.add(text)}`); plain.push(`${num} + ${o.text}`); }
    else if (o.t === '-') { lines.push(`${s.dim(num)} ${s.del('-')} ${s.del(text)}`); plain.push(`${num} - ${o.text}`); }
    else { lines.push(`${s.dim(num)}   ${s.dim(text)}`); plain.push(`${num}   ${o.text}`); }
  }
  if (skippedChanged) { lines.push(s.dim(`${' '.repeat(numW)}   ${s.glyph.ellipsis} ${skippedChanged} more changed line${skippedChanged === 1 ? '' : 's'}`)); plain.push(`... ${skippedChanged} more changed lines`); }
  return { lines, added, removed, plain: plain.join('\n'), isNew, width: width(lines[0] ?? '') };
}
