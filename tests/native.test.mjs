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

test('native encrypted SQLite journal survives restart and refuses schema downgrade', async () => {
  const { RecoveryJournal } = await import('../packages/local-runtime/journal.ts');
  const { randomBytes, randomUUID } = await import('node:crypto');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-journal-native-'));
  const dir = path.join(tmp, 'journal'),
    key = randomBytes(32),
    command = randomUUID();
  try {
    let j = new RecoveryJournal(dir, key);
    await j.append({
      id: randomUUID(),
      commandId: command,
      state: 'executing',
      body: { secret: 'encrypted fixture content' },
      at: Date.now(),
    });
    j.close();
    j = new RecoveryJournal(dir, key);
    assert.equal(j.record(command).state, 'executing');
    assert.equal(j.record(command).body.secret, 'encrypted fixture content');
    j.db.exec('PRAGMA user_version=2');
    j.close();
    assert.throws(() => new RecoveryJournal(dir, key), /refusing downgrade/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('native junction/symlink, hardlink and Windows alternate stream restrictions', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-path-native-'));
  const root = path.join(tmp, 'repo'),
    outside = path.join(tmp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private fixture');
  const wm = new WorkspaceManager(),
    w = await wm.open(root, { id: 'paths', kind: 'sovereign', issuer: 'paths', audience: 'paths' });
  try {
    fs.symlinkSync(outside, path.join(root, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => wm.read(w, 'jump/secret.txt'));
    fs.writeFileSync(path.join(root, 'source.txt'), 'source');
    fs.linkSync(path.join(root, 'source.txt'), path.join(root, 'alias.txt'));
    assert.throws(() => wm.call(w, { op: 'apply', path: 'alias.txt', beforeHash: null, after: 'refused' }));
    for (const p of ['x:stream', '../secret.txt', '/absolute', '.ENV']) {
      if (p === '.ENV' && process.platform !== 'win32') continue;
      assert.throws(() => wm.read(w, p));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('native supervisor records known exits and quarantines timed termination', async () => {
  if (process.platform === 'win32') return; // Native processes are deliberately unavailable on Windows.
  const { RecoveryJournal } = await import('../packages/local-runtime/journal.ts');
  const { PermissionEngine } = await import('../packages/local-runtime/permissions.ts');
  const { hash, id } = await import('../packages/agent-protocol/validation.ts');
  const { randomBytes } = await import('node:crypto');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-supervisor-native-'));
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  const wm = new WorkspaceManager(),
    w = await wm.open(root, { id: 'native', kind: 'sovereign', issuer: 'native', audience: 'native' });
  const journal = new RecoveryJournal(path.join(tmp, 'state'), randomBytes(32)),
    permissions = new PermissionEngine(w);
  const supervisor = new ExecutionSupervisor(w, journal, permissions);
  try {
    for (const [code, timeout, state] of [
      ['console.log("known exit")', 5000, 'succeeded'],
      ['setInterval(()=>{},100)', 100, 'uncertain'],
    ]) {
      const plan = {
        commandId: id(),
        workspaceId: w.id,
        hash: '',
        tool: 'process.run',
        args: { cwd: '.' },
        actions: ['execute'],
        paths: [],
        networkOrigins: [],
        timeoutMs: timeout,
        maxOutputBytes: 10000,
        executable: fs.realpathSync(process.execPath),
        argv: ['-e', code],
      };
      plan.hash = hash({ ...plan, hash: '' });
      const decision = await permissions.evaluate(plan, 'approval-required');
      assert.equal(decision.kind, 'prompt');
      const allowed = await permissions.approve(decision.request, plan, 'allow-once');
      await journal.append({
        id: id(),
        commandId: plan.commandId,
        state: 'claimed',
        body: { fixture: true },
        at: Date.now(),
      });
      const receipt = await supervisor.run(plan, allowed.grant, new AbortController().signal);
      assert.equal(receipt.state, state, JSON.stringify(receipt));
    }
  } finally {
    journal.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
