#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0])!==24) { console.error('SARION v2 requires Node 24'); process.exit(7); }
await import('../dist/sarion.mjs');
