import test from 'node:test';
import net from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from '../packages/local-runtime/workspace.ts';
import { sandboxProbe } from '../packages/platform/qualification.ts';
import { sandboxSupport, cleanEnvironment, macSandbox } from '../packages/platform/process.ts';
import { ExecutionSupervisor } from '../packages/local-runtime/supervisor.ts';
import { spawnSync } from 'node:child_process';

test('native rooted file helper: read, search, CAS edits, lock and protected paths', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-native-'));
  const prior = process.env.SARION_V2_HOME;
  process.env.SARION_V2_HOME = path.join(tmp, 'state');
  fs.mkdirSync(process.env.SARION_V2_HOME, { mode: 0o700 });
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  try {
    const wm = new WorkspaceManager(),
      w = await wm.open(root, {
        id: 'private',
        kind: 'sovereign',
        issuer: 'private',
        audience: 'private',
      });
    wm.call(w, {
      op: 'apply',
      path: 'src/new.txt',
      beforeHash: null,
      after: 'native test\n',
    });
    assert.equal(wm.read(w, 'src/new.txt'), 'native test\n');
    assert.ok(wm.files(w).includes('src/new.txt'));
    assert.equal(wm.search(w, 'native').matches.length, 1);
    assert.throws(() => wm.read(w, '../outside'), /Invalid|Protected/);
    assert.throws(
      () =>
        wm.call(w, {
          op: 'apply',
          path: 'src/new.txt',
          beforeHash: null,
          after: 'bad',
        }),
      /conflict/,
    );
    fs.writeFileSync(path.join(root, '.env'), 'secret');
    assert.throws(() => wm.read(w, '.env'), /Protected/);
    const lock = await wm.lock(w, 'test');
    try {
      await assert.rejects(wm.lock(w, 'second'));
    } finally {
      await lock.release();
    }
  } finally {
    if (prior === undefined) delete process.env.SARION_V2_HOME;
    else process.env.SARION_V2_HOME = prior;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('native containment: workspace writes, host reads and network denied', async () => {
  if (process.platform === 'win32') {
    assert.equal(sandboxSupport().available, false);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-containment-'));
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  const scratch = path.join(tmp, 'scratch');
  fs.mkdirSync(scratch);
  const listener = net.createServer((s) => s.destroy());
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const secret = path.join(tmp, 'host-secret');
  fs.writeFileSync(secret, 'host private');
  const nested = path.join(root, 'node_modules', 'fixture');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, '.env'), 'dependency secret');
  try {
    const probe = sandboxProbe(root);
    assert.equal(probe.verified, true, probe.reason);
    const code = `const fs=require('fs'),net=require('net');let n=0;for(const p of [${JSON.stringify(secret)},'node_modules/fixture/.env']){try{if(fs.readFileSync(p,'utf8').includes('secret'))process.exit(20)}catch{}n++}try{fs.writeFileSync('escape','bad');process.exit(21)}catch{n++}const s=net.connect({host:'127.0.0.1',port:${listener.address().port}});s.on('connect',()=>process.exit(22));s.on('error',()=>process.exit(n===3?0:23));setTimeout(()=>process.exit(24),3000);`;
    const mac = process.platform === 'darwin';
    const args = mac
      ? macSandbox(root, process.execPath, ['-e', code], fs.realpathSync(scratch))
      : ExecutionSupervisor.sandbox(root, process.execPath, ['-e', code]);
    const p = spawnSync(mac ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap', args, {
      cwd: root,
      env: cleanEnvironment(),
      timeout: 10000,
    });
    assert.equal(p.status, 0, p.stderr?.toString());
    assert.equal(fs.existsSync(path.join(root, 'escape')), false);
  } finally {
    await new Promise((r) => listener.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('native credential broker lifecycle on explicitly opted-in ephemeral runner', async (t) => {
  if (process.env.SARION_QUALIFY_CREDENTIALS !== '1' || process.platform === 'linux') {
    t.skip(
      'Requires explicit ephemeral native credential runner; Linux Secret Service needs its own provisioned session',
    );
    return;
  }
  const { CredentialStore } = await import('../packages/platform/credentials.ts');
  const prior = process.env.SARION_V2_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-credential-native-'));
  process.env.SARION_V2_HOME = tmp;
  const key = 'native-qualification@https://credential-fixture.invalid';
  try {
    const store = new CredentialStore();
    store.put(key, 'nonsecret-native-fixture-credential');
    assert.equal(new CredentialStore().token(key), 'nonsecret-native-fixture-credential');
    assert.equal(store.key(key).length, 32);
    store.remove(key);
    assert.throws(() => store.token(key), /login first/);
    if (process.platform === 'win32')
      assert.ok(
        !fs
          .readFileSync(path.join(tmp, 'vault.json'), 'utf8')
          .includes('nonsecret-native-fixture-credential'),
      );
  } finally {
    if (prior === undefined) delete process.env.SARION_V2_HOME;
    else process.env.SARION_V2_HOME = prior;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
