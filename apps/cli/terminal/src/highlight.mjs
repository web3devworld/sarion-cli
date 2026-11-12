// Syntax highlighting for fenced code blocks: the vendored highlight.js (cli/vendor/highlight, BSD-3-Clause), converted from its HTML spans to terminal colours.
// Everything is imported statically so the bundler puts it in the single downloadable file. Unknown languages and plain mode return the lines unchanged.
import hljs from '../vendor/highlight/core.js';
import javascriptLang from '../vendor/highlight/languages/javascript.js';
import typescriptLang from '../vendor/highlight/languages/typescript.js';
import pythonLang from '../vendor/highlight/languages/python.js';
import bashLang from '../vendor/highlight/languages/bash.js';
import shellLang from '../vendor/highlight/languages/shell.js';
import jsonLang from '../vendor/highlight/languages/json.js';
import sqlLang from '../vendor/highlight/languages/sql.js';
import xmlLang from '../vendor/highlight/languages/xml.js';
import cssLang from '../vendor/highlight/languages/css.js';
import scssLang from '../vendor/highlight/languages/scss.js';
import yamlLang from '../vendor/highlight/languages/yaml.js';
import markdownLang from '../vendor/highlight/languages/markdown.js';
import diffLang from '../vendor/highlight/languages/diff.js';
import goLang from '../vendor/highlight/languages/go.js';
import rustLang from '../vendor/highlight/languages/rust.js';
import javaLang from '../vendor/highlight/languages/java.js';
import cLang from '../vendor/highlight/languages/c.js';
import cppLang from '../vendor/highlight/languages/cpp.js';
import csharpLang from '../vendor/highlight/languages/csharp.js';
import phpLang from '../vendor/highlight/languages/php.js';
import rubyLang from '../vendor/highlight/languages/ruby.js';
import powershellLang from '../vendor/highlight/languages/powershell.js';
import dockerfileLang from '../vendor/highlight/languages/dockerfile.js';
import iniLang from '../vendor/highlight/languages/ini.js';
import kotlinLang from '../vendor/highlight/languages/kotlin.js';
import swiftLang from '../vendor/highlight/languages/swift.js';
import luaLang from '../vendor/highlight/languages/lua.js';
import makefileLang from '../vendor/highlight/languages/makefile.js';
import nginxLang from '../vendor/highlight/languages/nginx.js';
import perlLang from '../vendor/highlight/languages/perl.js';
import plaintextLang from '../vendor/highlight/languages/plaintext.js';
import graphqlLang from '../vendor/highlight/languages/graphql.js';
import propertiesLang from '../vendor/highlight/languages/properties.js';

const LANGS = { javascript: javascriptLang, typescript: typescriptLang, python: pythonLang, bash: bashLang, shell: shellLang, json: jsonLang, sql: sqlLang, xml: xmlLang, css: cssLang, scss: scssLang, yaml: yamlLang, markdown: markdownLang, diff: diffLang, go: goLang, rust: rustLang, java: javaLang, c: cLang, cpp: cppLang, csharp: csharpLang, php: phpLang, ruby: rubyLang, powershell: powershellLang, dockerfile: dockerfileLang, ini: iniLang, kotlin: kotlinLang, swift: swiftLang, lua: luaLang, makefile: makefileLang, nginx: nginxLang, perl: perlLang, plaintext: plaintextLang, graphql: graphqlLang, properties: propertiesLang };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

const ALIASES = { sh: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash', 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', golang: 'go', rs: 'rust', kt: 'kotlin', ps1: 'powershell', docker: 'dockerfile', toml: 'ini', yml: 'yaml', md: 'markdown', html: 'xml', svg: 'xml', vue: 'xml', jsonc: 'json', tsx: 'typescript', jsx: 'javascript', text: 'plaintext', txt: 'plaintext' };

/** The registered language a fence label names, or null. */
export function languageFor(label) {
  const raw = String(label || '').trim().toLowerCase().split(/[\s{]/)[0];
  if (!raw) return null;
  const name = ALIASES[raw] || raw;
  const found = hljs.getLanguage(name);
  return found ? (found.name ? name : name) : null;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const decode = (t) => t.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m]);

/** Which palette entry paints a token whose innermost class list is `classes` (hljs-title function_ and the like). */
export function tokenKind(classes) {
  const c = new Set(classes.flatMap((x) => x.split(/\s+/)));
  if (c.has('hljs-comment') || c.has('hljs-quote')) return 'comment';
  if (c.has('hljs-deletion')) return 'del';
  if (c.has('hljs-addition')) return 'add';
  if (c.has('hljs-keyword') || c.has('hljs-selector-tag') || c.has('hljs-doctag')) return 'keyword';
  if (c.has('hljs-title') && (c.has('class_') || c.has('hljs-type'))) return 'type';
  if (c.has('hljs-title') || c.has('hljs-built_in') || c.has('hljs-section')) return 'func';
  if (c.has('hljs-type') || c.has('hljs-class')) return 'type';
  if (c.has('hljs-string') || c.has('hljs-regexp') || c.has('hljs-symbol') || c.has('hljs-bullet')) return 'string';
  if (c.has('hljs-number')) return 'number';
  if (c.has('hljs-literal')) return 'literal';
  if (c.has('hljs-attr') || c.has('hljs-attribute') || c.has('hljs-property') || c.has('hljs-template-variable') || c.has('hljs-selector-class') || c.has('hljs-selector-id')) return 'attr';
  if (c.has('hljs-name') || c.has('hljs-tag')) return 'tag';
  if (c.has('hljs-meta')) return 'meta';
  return null;
}

/** HTML from highlight.js to one terminal-coloured string per source line. Spans that cross a line break are re-opened on each line. */
export function htmlToLines(html, style) {
  const lines = []; let cur = ''; const stack = [];
  const re = /<span class="([^"]*)">|<\/span>|\n|[^<\n]+/g; let m;
  const paint = (text) => { for (let i = stack.length - 1; i >= 0; i--) { const k = tokenKind(stack.slice(i, i + 1)); if (k) return k === 'comment' ? style.comment(style.italic(text)) : style[k](text); } return text; };
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[0] === '</span>') stack.pop();
    else if (m[0] === '\n') { lines.push(cur); cur = ''; }
    else cur += paint(decode(m[0]));
  }
  lines.push(cur);
  return lines;
}

/** Colours the lines of a code block. The block is highlighted as a whole, so a comment or string that spans lines is coloured correctly. */
export function highlightLines(lines, label, style) {
  const lang = languageFor(label);
  if (!style.on || !lang || lang === 'plaintext') return lines;
  try { return htmlToLines(hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value, style); } catch { return lines; }
}

