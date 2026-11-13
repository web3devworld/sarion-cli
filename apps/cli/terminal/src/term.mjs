// What the terminal can show: colour depth, width, unicode, light or dark background. Everything the renderer draws depends only on this object, so it is testable
// with a fake one. NO_COLOR, --no-color and a non-terminal output all mean plain text with no escape codes at all.
import process from 'node:process';

export function detectTerm({ env = process.env, stream = process.stdout, platform = process.platform, flags = {} } = {}) {
  const tty = Boolean(stream && stream.isTTY);
  const force = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0';
  const noColor = flags.noColor === true || (env.NO_COLOR !== undefined && env.NO_COLOR !== '') || env.TERM === 'dumb';
  const color = !noColor && (tty || force);
  let depth = 1;
  if (color) {
    const ct = String(env.COLORTERM || '').toLowerCase();
    if (ct === 'truecolor' || ct === '24bit') depth = 24;
    else if (tty && typeof stream.getColorDepth === 'function') depth = stream.getColorDepth(env);
    else if (/256color/.test(env.TERM || '')) depth = 8;
    else depth = 4;
    if (depth < 4) depth = 4;
    if (env.WT_SESSION && depth < 24) depth = 24; // Windows Terminal draws truecolor
  }
  const columns = Math.min(Math.max(Number(stream && stream.columns) || 80, 40), 140);
  const ascii = env.SARION_ASCII === '1' || env.TERM === 'linux' || (platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM && !env.ConEmuANSI);
  const bg = Number(String(env.COLORFGBG || '').split(';').pop());
  const theme = flags.theme === 'light' || flags.theme === 'dark' ? flags.theme : env.SARION_THEME === 'light' || env.SARION_THEME === 'dark' ? env.SARION_THEME : (bg === 7 || (bg >= 9 && bg <= 15) ? 'light' : 'dark');
  return { tty, color, depth, columns, unicode: !ascii, theme, animate: tty && !noColor && env.CI === undefined };
}
