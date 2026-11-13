#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('SARION v2 requires Node 24');
  process.exit(7);
}
if (process.argv.length === 3 && ['--version', '-v', 'version'].includes(process.argv[2])) {
  const { readFileSync } = await import('node:fs');
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else await import('../dist/sarion.mjs');
