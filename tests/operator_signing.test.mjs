import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sha256, verifyRelease } from '../scripts/release-verification.mjs';

test('operator tooling signs an encrypted fixture key; rejects wrong trust/source, tampering and unsafe keys', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-signing-fixture-'));
  fs.chmodSync(tmp, 0o700);
  try {
    const bundle = path.join(tmp, 'bundle');fs.mkdirSync(bundle);
    const pair = generateKeyPairSync('ed25519');
    const privateFile = path.join(tmp, 'fixture-private.pem'), publicFile = path.join(tmp, 'fixture-public.pem');
    const passphrase = 'ephemeral-test-only-unlock';
    fs.writeFileSync(privateFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }), { mode: 0o600 });
    fs.writeFileSync(publicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const fingerprint = sha256(pair.publicKey.export({ type: 'spki', format: 'der' }));
    const source = 'a'.repeat(40), file = 'volta-sarion-cli-2.0.0-preview.2.tgz';
    const payload = Buffer.from('fixture package bytes');fs.writeFileSync(path.join(bundle, file), payload);
    const evidence = {
      'build-provenance.json': JSON.stringify({ sourceCommit: source, lockSha256: 'b'.repeat(64) }),
      'sbom.cdx.json': JSON.stringify({ bomFormat: 'CycloneDX', metadata: { component: { version: '2.0.0-preview.2' } } }),
    };
    for (const [name, value] of Object.entries(evidence)) fs.writeFileSync(path.join(bundle, name), value);
    const manifest = JSON.stringify({ version: '2.0.0-preview.2', protocol: '1.0', file, bytes: payload.length,
      sha256: sha256(payload), evidence: Object.fromEntries(Object.entries(evidence).map(([n, v]) => [n, sha256(v)])) });
    fs.writeFileSync(path.join(bundle, 'manifest.json'), manifest);
    const run = (script, args, input) => spawnSync(process.execPath, ['scripts/' + script, ...args], { encoding: 'utf8', input, timeout: 15000 });
    const signArgs = [bundle, privateFile, publicFile, fingerprint, source, '--passphrase-stdin'];
    let r = run('sign-release.mjs', signArgs, passphrase + '\n');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(passphrase) && !r.stderr.includes(passphrase));
    assert.equal(run('verify-release.mjs', [bundle, publicFile, fingerprint]).status, 0);
    // Concurrent replacement after the signature read must not let a second,
    // unsigned manifest authenticate attacker-controlled package bytes.
    const originalRead = fs.readFileSync;
    let swapped = false;
    fs.readFileSync = (file, ...options) => {
      const data = originalRead(file, ...options);
      if (file === path.join(bundle, 'manifest.json') && !swapped) {
        swapped = true;
        const other = Buffer.from('unsigned replacement package');
        fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({ ...JSON.parse(manifest), bytes: other.length, sha256: sha256(other) }));
        fs.writeFileSync(path.join(bundle, JSON.parse(manifest).file), other);
      }
      return data;
    };
    try { assert.throws(() => verifyRelease(bundle, pair.publicKey), /Package checksum mismatch/); }
    finally { fs.readFileSync = originalRead; fs.writeFileSync(path.join(bundle, 'manifest.json'), manifest); fs.writeFileSync(path.join(bundle, file), payload); }
    assert.notEqual(run('verify-release.mjs', [bundle, publicFile, '0'.repeat(64)]).status, 0);
    assert.notEqual(run('sign-release.mjs', [...signArgs.slice(0, 4), 'c'.repeat(40), '--passphrase-stdin'], passphrase + '\n').status, 0);
    fs.appendFileSync(path.join(bundle, file), 'tampered');
    assert.notEqual(run('verify-release.mjs', [bundle, publicFile, fingerprint]).status, 0);
    fs.writeFileSync(path.join(bundle, file), payload);
    fs.appendFileSync(path.join(bundle, 'sbom.cdx.json'), ' ');
    assert.notEqual(run('verify-release.mjs', [bundle, publicFile, fingerprint]).status, 0);
    fs.writeFileSync(path.join(bundle, 'sbom.cdx.json'), evidence['sbom.cdx.json']);
    fs.writeFileSync(path.join(bundle, 'manifest.sig'), Buffer.alloc(64).toString('base64'));
    assert.notEqual(run('verify-release.mjs', [bundle, publicFile, fingerprint]).status, 0);
    if (process.platform !== 'win32') {
      fs.chmodSync(privateFile, 0o644);
      r = run('sign-release.mjs', signArgs, passphrase + '\n');
      assert.notEqual(r.status, 0);assert.match(r.stderr, /owner-only/);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
