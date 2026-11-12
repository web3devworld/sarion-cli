import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-artifact-')),
  bundle = path.join(tmp, 'bundle'),
  prefix = path.join(tmp, 'install');
fs.mkdirSync(bundle);
const manifest = JSON.parse(fs.readFileSync('artifacts/manifest.json', 'utf8'));
fs.copyFileSync('artifacts/manifest.json', path.join(bundle, 'manifest.json'));
fs.copyFileSync(path.join('artifacts', manifest.file), path.join(bundle, manifest.file));
const keys = generateKeyPairSync('ed25519');
const publicFile = path.join(tmp, 'test-public.pem');
fs.writeFileSync(publicFile, keys.publicKey.export({ type: 'spki', format: 'pem' }));
fs.writeFileSync(
  path.join(bundle, 'manifest.sig'),
  sign(null, fs.readFileSync(path.join(bundle, 'manifest.json')), keys.privateKey).toString('base64'),
);
try {
  execFileSync(process.execPath, ['scripts/install.mjs', bundle, prefix], {
    env: { ...process.env, SARION_RELEASE_PUBLIC_KEY: publicFile },
    stdio: 'pipe',
  });
  const launcher = path.join(prefix, 'bin', 'sarion');
  assert.equal(execFileSync(process.execPath, [launcher, '--version'], { encoding: 'utf8' }).trim(), '2.0.0-preview.1');
  assert.match(execFileSync(process.execPath, [launcher, '--help'], { encoding: 'utf8' }), /trusted-automation/);
  fs.writeFileSync(path.join(bundle, 'manifest.sig'), Buffer.alloc(64).toString('base64'));
  const bad = spawnSync(process.execPath, ['scripts/install.mjs', bundle, prefix], {
    env: { ...process.env, SARION_RELEASE_PUBLIC_KEY: publicFile },
    encoding: 'utf8',
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Invalid release signature/);
  console.log(
    'PASS: offline tarball install/start/help and signature rejection using ephemeral fixture key; release artifact remains unsigned',
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
