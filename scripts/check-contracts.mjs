import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const before = fs.readFileSync('packages/agent-protocol/schema.json');
execFileSync(process.execPath, ['scripts/generate-schema.mjs'], { stdio: 'inherit' });
const after = fs.readFileSync('packages/agent-protocol/schema.json');
if (!before.equals(after)) throw Error('Protocol schemas were stale; regenerated output must be reviewed');
console.log('Protocol schema synchronized ' + createHash('sha256').update(after).digest('hex'));
