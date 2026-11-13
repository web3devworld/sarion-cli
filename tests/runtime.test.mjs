import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hash, id, contentHash } from '../packages/agent-protocol/validation.ts';
import { WorkspaceManager, ContextProvider } from '../packages/local-runtime/workspace.ts';
import { RecoveryJournal } from '../packages/local-runtime/journal.ts';
import { PermissionEngine, ApprovalController } from '../packages/local-runtime/permissions.ts';
import { LocalToolRegistry } from '../packages/local-runtime/tools.ts';
import { ExecutionSupervisor } from '../packages/local-runtime/supervisor.ts';
import { CredentialStore } from '../packages/platform/credentials.ts';
async function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-v2-test-'));
  fs.chmodSync(tmp, 0o700);
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  spawnSync('/usr/bin/git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'a.txt'), 'old A\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'old B\n');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=do-not-disclose');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'ignored');
  const wm = new WorkspaceManager(),
    w = await wm.open(root, { id: 'fixture', kind: 'cloud', issuer: 'fixture', audience: 'fixture' });
  const journal = new RecoveryJournal(path.join(tmp, 'state'), randomBytes(32)),
    permission = new PermissionEngine(w),
    tools = new LocalToolRegistry(wm, w, journal, permission);
  return {
    tmp,
    root,
    wm,
    w,
    journal,
    permission,
    tools,
    close() {
      journal.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
const request = (f, tool, args) => ({
  commandId: id(),
  parentCommandId: id(),
  tool,
  toolVersion: '1',
  args,
  argsHash: hash(args),
  workspaceId: f.w.id,
  expectedWorkspaceRevision: f.w.revision,
  policyRevision: 'fixture',
  expiresAt: Date.now() + 100000,
});
async function authorized(f, r, mode = 'workspace-write') {
  const p = await f.tools.plan(r, f.w);
  let d = await f.permission.evaluate(p, mode);
  if (d.kind === 'prompt') d = await f.permission.approve(d.request, p, 'allow-once');
  assert.equal(d.kind, 'allow');
  f.journal.put('plan:' + d.grant.id, p);
  await f.journal.append({ id: id(), commandId: r.commandId, state: 'claimed', body: r, at: Date.now() });
  return { p, g: d.grant };
}
test('descriptor paths reject traversal, symlinks, secrets and ignored content', async () => {
  const f = await fixture();
  try {
    assert.equal(f.wm.read(f.w, 'a.txt'), 'old A\n');
    for (const p of ['../a.txt', '/etc/passwd', '.env', '.git/config', 'ignored.txt'])
      assert.throws(() => f.wm.read(f.w, p));
    fs.symlinkSync('/etc/passwd', path.join(f.root, 'escape'));
    assert.throws(() => f.wm.read(f.w, 'escape'));
    assert.ok(!f.wm.files(f.w).includes('ignored.txt'));
    const chunks = await new ContextProvider(f.wm).collect(f.w, ['a.txt'], id());
    assert.equal(chunks.length, 1);
    assert.equal(
      (
        await new ContextProvider(f.wm).incremental(
          [{ id: id(), path: chunks[0].path, sha256: chunks[0].sha256, revision: chunks[0].revision }],
          chunks,
        )
      ).length,
      0,
    );
  } finally {
    f.close();
  }
});
test('permissions deny default writes, shell and forged/expired grants', async () => {
  const f = await fixture();
  try {
    const r = request(f, 'patch.apply', {
      files: [{ path: 'a.txt', beforeHash: contentHash('old A\n'), after: 'new' }],
    });
    const plan = await f.tools.plan(r, f.w);
    assert.equal((await f.permission.evaluate(plan, 'read-only')).kind, 'deny');
    assert.equal((await f.permission.evaluate(plan, 'trusted-automation')).kind, 'deny');
    await assert.rejects(
      f.permission.validate({ id: id(), planHash: plan.hash, expiresAt: Date.now() + 1e4 }, plan),
    );
    await assert.rejects(
      f.permission.approve(
        { id: id(), commandId: r.commandId, actionHash: plan.hash, expiresAt: Date.now() + 1e4 },
        plan,
        'allow-once',
      ),
    );
    const d = await f.permission.evaluate(plan, 'approval-required');
    assert.equal(d.kind, 'prompt');
    const changed = { ...plan, args: { different: true } };
    await assert.rejects(f.permission.approve(d.request, changed, 'allow-once'));
  } finally {
    f.close();
  }
});
test('multi-file patch, nested creation, checkpoint and concurrent-edit recovery', async () => {
  const f = await fixture();
  try {
    const r = request(f, 'patch.apply', {
      files: [
        { path: 'a.txt', beforeHash: contentHash('old A\n'), after: 'new A\n' },
        { path: 'b.txt', beforeHash: contentHash('old B\n'), after: 'new B\n' },
        { path: 'new/c.txt', beforeHash: null, after: 'created\n' },
      ],
    });
    const { p, g } = await authorized(f, r);
    const receipt = await f.tools.execute(r, g, new AbortController().signal);
    assert.equal(receipt.state, 'succeeded');
    assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'new A\n');
    assert.equal(fs.readFileSync(path.join(f.root, 'new/c.txt'), 'utf8'), 'created\n');
    assert.equal(await f.tools.patch.reconcile(p.args.patch.id), 'applied');
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'human edit');
    assert.equal(await f.tools.patch.reconcile(p.args.patch.id), 'unknown');
    await assert.rejects(
      f.tools.patch.prepare(f.w, [{ path: 'a.txt', beforeHash: contentHash('new A\n'), after: 'old A\n' }]),
    );
    assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'human edit');
    await assert.rejects(f.tools.execute(r, g, new AbortController().signal));
  } finally {
    f.close();
  }
});
test('hardlinked files cannot be mutated', async () => {
  const f = await fixture();
  try {
    fs.linkSync(path.join(f.root, 'a.txt'), path.join(f.tmp, 'outside-link'));
    const r = request(f, 'patch.apply', {
      files: [{ path: 'a.txt', beforeHash: contentHash('old A\n'), after: 'bad' }],
    });
    const { g } = await authorized(f, r);
    await assert.rejects(f.tools.execute(r, g, new AbortController().signal), /partially applied/);
    assert.equal(fs.readFileSync(path.join(f.tmp, 'outside-link'), 'utf8'), 'old A\n');
  } finally {
    f.close();
  }
});
test('journal encryption, CAS transitions, crash reopen and receipt idempotency', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-journal-'));
  fs.chmodSync(tmp, 0o700);
  const key = randomBytes(32),
    c = id();
  let j = new RecoveryJournal(tmp, key);
  try {
    await j.append({
      id: id(),
      commandId: c,
      state: 'claimed',
      body: { secret: 'fixture plaintext marker' },
      at: Date.now(),
    });
    await j.transition(c, 'claimed', 'executing', { secret: 'fixture plaintext marker' });
    await assert.rejects(j.transition(c, 'claimed', 'executing', {}));
    j.close();
    j = new RecoveryJournal(tmp, key);
    assert.equal((await j.pending())[0].state, 'executing');
    assert.equal(j.record(c).body.secret, 'fixture plaintext marker');
    j.close();
    assert.ok(
      !fs.readFileSync(path.join(tmp, 'recovery.sqlite')).includes(Buffer.from('fixture plaintext marker')),
    );
    j = new RecoveryJournal(tmp, key);
  } finally {
    j.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('explicit encrypted credential store never persists token plaintext and wrong key refuses', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-vault-'));
  fs.chmodSync(tmp, 0o700);
  const old = process.env.SARION_V2_HOME;
  process.env.SARION_V2_HOME = tmp;
  try {
    const store = new CredentialStore('fixture passphrase is sufficiently long');
    store.put('fixture', 'sar_cli_' + 'a'.repeat(64));
    assert.equal(store.token('fixture'), 'sar_cli_' + 'a'.repeat(64));
    assert.equal(store.key('fixture').length, 32);
    assert.ok(!fs.readFileSync(path.join(tmp, 'vault.json'), 'utf8').includes('sar_cli_'));
    assert.throws(() => new CredentialStore('wrong fixture passphrase').read(), /unlock/);
  } finally {
    if (old) process.env.SARION_V2_HOME = old;
    else delete process.env.SARION_V2_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('real isolated supervisor output, writable temp, read-only root and no duplicate dispatch', async (t) => {
  const f = await fixture();
  try {
    const probe = spawnSync('/usr/bin/bwrap', [
      '--unshare-all',
      '--ro-bind',
      '/',
      '/',
      '--',
      '/usr/bin/true',
    ]);
    if (probe.status !== 0) {
      t.skip('Host user namespace/bubblewrap unavailable: ' + probe.stderr.toString().slice(0, 180));
      return;
    }
    const r = request(f, 'process.run', {
      file: process.execPath,
      argv: [
        '-e',
        'const fs=require("fs"); console.log("fixture output"); try {fs.writeFileSync("a.txt","bad")} catch(e) {console.log("root-write-denied")} fs.writeFileSync("/tmp/ok","yes"); console.log(process.env.SARION_TOKEN||"no-token")',
      ],
      cwd: '.',
      timeoutMs: 10000,
      network: 'deny',
    });
    const { g } = await authorized(f, r, 'approval-required');
    const receipt = await f.tools.execute(r, g, new AbortController().signal);
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
    assert.match(receipt.output.excerpt, /root-write-denied/);
    assert.match(receipt.output.excerpt, /no-token/);
    assert.equal(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'old A\n');
    await assert.rejects(f.tools.execute(r, g, new AbortController().signal));
  } finally {
    f.close();
  }
});
test('workspace OS lock excludes a second executor', async () => {
  const f = await fixture();
  try {
    process.env.SARION_V2_HOME = path.join(f.tmp, 'locks');
    const one = await f.wm.lock(f.w, id());
    try {
      await assert.rejects(f.wm.lock(f.w, id()), /already owned/);
    } finally {
      await one.release();
    }
  } finally {
    delete process.env.SARION_V2_HOME;
    f.close();
  }
});
test('real process timeout is uncertain and never retried automatically', async (t) => {
  const f = await fixture();
  try {
    const probe = spawnSync('/usr/bin/bwrap', [
      '--unshare-all',
      '--ro-bind',
      '/',
      '/',
      '--',
      '/usr/bin/true',
    ]);
    if (probe.status !== 0) {
      t.skip('Host isolation unavailable');
      return;
    }
    const r = request(f, 'process.run', {
      file: process.execPath,
      argv: ['-e', 'setInterval(()=>{},1000)'],
      cwd: '.',
      timeoutMs: 100,
      network: 'deny',
    });
    const { g } = await authorized(f, r, 'approval-required');
    const at = Date.now(),
      receipt = await f.tools.execute(r, g, new AbortController().signal);
    assert.equal(receipt.state, 'uncertain');
    assert.ok(Date.now() - at < 5000);
    await assert.rejects(f.tools.execute(r, g, new AbortController().signal));
  } finally {
    f.close();
  }
});
test('Git stage/commit require explicit approval and ignore hostile clean filters', async (t) => {
  const f = await fixture();
  try {
    const probe = spawnSync('/usr/bin/bwrap', [
      '--unshare-all',
      '--ro-bind',
      '/',
      '/',
      '--',
      '/usr/bin/true',
    ]);
    if (probe.status !== 0) {
      t.skip('Host isolation unavailable');
      return;
    }
    for (const args of [
      ['config', 'user.name', 'Fixture'],
      ['config', 'user.email', 'fixture@example.invalid'],
      ['config', 'filter.evil.clean', 'printf compromised'],
      ['config', 'filter.evil.required', 'true'],
    ])
      assert.equal(spawnSync('/usr/bin/git', ['-C', f.root, ...args]).status, 0);
    fs.writeFileSync(path.join(f.root, '.gitattributes'), 'a.txt filter=evil\n');
    const stage = request(f, 'git.stage', { paths: ['a.txt'] });
    const plan = await f.tools.plan(stage, f.w);
    assert.equal((await f.permission.evaluate(plan, 'workspace-write')).kind, 'prompt');
    const { g } = await authorized(f, stage, 'approval-required');
    const receipt = await f.tools.execute(stage, g, new AbortController().signal);
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
    const indexed = spawnSync('/usr/bin/git', ['-C', f.root, 'show', ':a.txt'], { encoding: 'utf8' });
    assert.equal(indexed.stdout, 'old A\n');
    const commit = request(f, 'git.commit', { message: 'Fixture commit' });
    const approved = await authorized(f, commit, 'approval-required');
    assert.equal(
      (await f.tools.execute(commit, approved.g, new AbortController().signal)).state,
      'succeeded',
    );
    const secret = request(f, 'git.stage', { paths: ['.env'] });
    await assert.rejects(f.tools.plan(secret, f.w));
  } finally {
    f.close();
  }
});
test('acknowledged source output expires while unknown receipts remain recoverable', async () => {
  const f = await fixture();
  try {
    for (const state of ['succeeded', 'uncertain']) {
      const command = id(),
        base = {
          receiptId: id(),
          sessionId: id(),
          commandId: command,
          parentCommandId: id(),
          claimId: id(),
          executorId: id(),
          argsHash: 'a'.repeat(64),
          workspaceId: f.w.id,
          policyRevision: 'p1',
          approvalDecisionId: null,
          state,
          startedAt: Date.now() - 9 * 86400000,
          endedAt: Date.now() - 9 * 86400000,
          exitCode: state === 'succeeded' ? 0 : null,
          signal: null,
          output: null,
          effects: [],
          result: { content: 'old private source' },
          evidence: [],
        };
      f.journal.storeReceipt({ ...base, receiptHash: hash(base) });
      f.journal.ack(command, hash(base));
      await f.journal.prune(Date.now());
      assert.equal((await f.journal.receipt(command)) === null, state === 'succeeded');
    }
  } finally {
    f.close();
  }
});

test('Git commit rejects a protected path staged outside the CLI', async () => {
  const f = await fixture();
  try {
    assert.equal(spawnSync('/usr/bin/git', ['-C', f.root, 'add', '-f', '--', '.env']).status, 0);
    await assert.rejects(
      f.tools.plan(request(f, 'git.commit', { message: 'must not include secret' }), f.w),
      /protected or unapproved/,
    );
    assert.match(
      spawnSync('/usr/bin/git', ['-C', f.root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
        .stdout,
      /\.env/,
    );
  } finally {
    f.close();
  }
});

test('Git diff includes new source files through the protected reader and excludes secrets', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'new.mjs'), 'export const product=(a,b)=>a*b;\n');
    fs.writeFileSync(path.join(f.root, 'no-newline.txt'), 'tail');
    const diff = await f.tools.git.diff(f.w, []);
    assert.match(diff, /\+export const product=\(a,b\)=>a\*b;/);
    assert.match(diff, /\+tail\n\\ No newline at end of file/);
    assert.ok(!diff.includes('do-not-disclose') && !diff.includes('b/ignored.txt'));
    assert.equal(await f.tools.git.diff(f.w, ['.env']), '');
  } finally { f.close(); }
});

test('model empty fs.list directory means repository root and preserves exclusions', async () => {
  const f = await fixture();
  try {
    const r = request(f, 'fs.list', { directory: '' });
    const { g } = await authorized(f, r, 'read-only');
    const receipt = await f.tools.execute(r, g, new AbortController().signal);
    assert.equal(receipt.state, 'succeeded');
    assert.ok(receipt.result.files.includes('a.txt'));
    assert.ok(!receipt.result.files.includes('.env'));
    assert.ok(!receipt.result.files.includes('ignored.txt'));
  } finally {
    f.close();
  }
});
