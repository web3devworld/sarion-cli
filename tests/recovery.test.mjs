import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CliSessionManager } from '../apps/cli/src/session.ts';
import { WorkspaceManager } from '../packages/local-runtime/workspace.ts';
import { RecoveryJournal } from '../packages/local-runtime/journal.ts';
import { PermissionEngine, ApprovalController } from '../packages/local-runtime/permissions.ts';
import { LocalToolRegistry } from '../packages/local-runtime/tools.ts';
import { id, hash, contentHash, Failure } from '../packages/agent-protocol/validation.ts';
async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-recovery-'));
  fs.chmodSync(tmp, 0o700);
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  spawnSync('/usr/bin/git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'file.txt'), 'fixture data');
  const wm = new WorkspaceManager(),
    w = await wm.open(root, { id: 'fixture', kind: 'cloud', issuer: 'fixture', audience: 'fixture' }),
    journal = new RecoveryJournal(path.join(tmp, 'state'), randomBytes(32)),
    permission = new PermissionEngine(w),
    tools = new LocalToolRegistry(wm, w, journal, permission);
  const sid = id(),
    parent = id(),
    executor = { value: null },
    counters = { claims: 0, executions: 0, uploads: 0 };
  let failClaim = false,
    failReceipt = false;
  const snapshot = {
    sessionId: sid,
    conversationId: id(),
    principal: { subject: 'u', tenantId: 't', accountId: 'a', scopes: [] },
    boundary: { id: 'fixture', kind: 'cloud', issuer: 'fixture', audience: 'fixture' },
    revision: 1,
    conversationSeq: 0,
    eventCursor: 0,
    taskId: parent,
    active: [],
    policyRevision: 'p1',
  };
  const client = {
    profile: { url: 'https://fixture.test' },
    open: async () => snapshot,
    snapshot: async () => snapshot,
    approve: async () => {},
    claim: async (_s, _c, input) => {
      counters.claims++;
      executor.value = input.executorId;
      if (failClaim) throw Error('lost claim ACK');
      return { granted: true, claimId: input.claimId, executionToken: 'fixture execution token' };
    },
    status: async (_s, c) => ({
      commandId: c,
      state: c === parent ? 'awaiting_tool' : 'running',
      execution: { state: 'claimed', executorId: executor.value },
    }),
    receipt: async (r) => {
      counters.uploads++;
      if (failReceipt) {
        failReceipt = false;
        throw Error('lost receipt ACK');
      }
      return { recorded: true, commandId: r.commandId, receiptHash: r.receiptHash, revision: 1 };
    },
    cancel: async () => ({ commandId: parent, state: 'cancel_requested' }),
  };
  const original = tools.execute.bind(tools);
  tools.execute = async (...args) => {
    counters.executions++;
    return original(...args);
  };
  const manager = new CliSessionManager(
    client,
    journal,
    w,
    wm,
    tools,
    new ApprovalController(permission, async () => true, true),
    'approval-required',
    () => {},
  );
  await manager.open(
    {
      openId: id(),
      workspace: { id: w.id, rootHash: 'a'.repeat(64), revision: w.revision },
      level: 'B',
      mode: 'approval-required',
      tools: tools.descriptors(),
    },
    { id: 'fixture', profile: 'fixture' },
  );
  const request = {
    commandId: id(),
    parentCommandId: parent,
    tool: 'fs.read',
    toolVersion: '1',
    args: { path: 'file.txt' },
    argsHash: hash({ path: 'file.txt' }),
    workspaceId: w.id,
    expectedWorkspaceRevision: w.revision,
    policyRevision: 'p1',
    expiresAt: Date.now() + 100000,
  };
  return {
    manager,
    journal,
    request,
    counters,
    sid,
    setLostClaim() {
      failClaim = true;
    },
    setLostReceipt() {
      failReceipt = true;
    },
    close() {
      journal.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
test('lost claim ACK is quarantined and never redispatched on replay', async () => {
  const f = await setup();
  try {
    f.setLostClaim();
    await assert.rejects(f.manager.tool(f.request, new AbortController().signal), /lost claim/);
    await assert.rejects(f.manager.tool(f.request, new AbortController().signal), /never automatically replayed/);
    assert.equal(f.counters.claims, 1);
    assert.equal(f.counters.executions, 0);
    assert.equal(f.journal.record(f.request.commandId).state, 'claim_pending');
  } finally {
    f.close();
  }
});
test('lost receipt ACK reuploads the same durable receipt without another execution', async () => {
  const f = await setup();
  try {
    f.setLostReceipt();
    await assert.rejects(f.manager.tool(f.request, new AbortController().signal), /lost receipt/);
    const receipt = await f.journal.receipt(f.request.commandId);
    assert.equal(receipt.state, 'succeeded');
    assert.equal(f.journal.outbox().length, 1);
    await f.manager.recover(f.sid);
    assert.equal(f.journal.outbox().length, 0);
    await f.manager.tool(f.request, new AbortController().signal);
    assert.equal(f.counters.claims, 1);
    assert.equal(f.counters.executions, 1);
    assert.equal(f.counters.uploads, 3);
  } finally {
    f.close();
  }
});
test('executing marker without receipt blocks recovery replay', async () => {
  const f = await setup();
  try {
    await f.journal.append({
      id: id(),
      commandId: f.request.commandId,
      state: 'executing',
      body: f.request,
      at: Date.now(),
    });
    await assert.rejects(f.manager.tool(f.request, new AbortController().signal), /reconciliation/);
    assert.equal(f.counters.executions, 0);
    await f.manager.cancel(f.request.parentCommandId);
    assert.equal(f.journal.audits()[0].state, 'cancel_requested');
  } finally {
    f.close();
  }
});

test('read-only policy denial has a durable receipt and lost ACK never claims or executes', async () => {
  const f = await setup();
  try {
    f.manager.mode = 'read-only';
    const args = { files: [{ path: 'file.txt', beforeHash: contentHash('fixture data'), after: 'forbidden' }] };
    const request = { ...f.request, commandId: id(), tool: 'patch.apply', args, argsHash: hash(args) };
    f.setLostReceipt();
    await assert.rejects(f.manager.tool(request, new AbortController().signal), /lost receipt/);
    const receipt = await f.journal.receipt(request.commandId);
    assert.equal(receipt.state, 'denied');
    assert.equal(receipt.result.executed, false);
    assert.deepEqual(receipt.effects, []);
    assert.equal(receipt.startedAt, null);
    assert.equal(f.journal.outbox().length, 1);
    await f.manager.recover(f.sid);
    await f.manager.tool(request, new AbortController().signal);
    assert.equal(f.counters.claims, 0);
    assert.equal(f.counters.executions, 0);
    assert.equal(f.journal.outbox().length, 0);
    assert.equal(f.journal.record(request.commandId).state, 'acked');
  } finally { f.close(); }
});

test('changed-policy errors remain fail-closed rather than becoming a model continuation', async () => {
  const f = await setup();
  try {
    f.manager.approvals.authorize = async () => { throw new Failure('POLICY_DENIED', 'Policy changed; restart task', 4); };
    await assert.rejects(f.manager.tool(f.request, new AbortController().signal), /Policy changed/);
    assert.equal(await f.journal.receipt(f.request.commandId), null);
    assert.equal(f.counters.claims, 0);
    assert.equal(f.counters.executions, 0);
  } finally { f.close(); }
});

test('unresolved earlier workspace mutation blocks new mutation until explicit disposition', async () => {
  const f = await setup();
  try {
    const parent = id();
    await f.journal.append({
      id: id(),
      commandId: id(),
      state: 'uncertain',
      body: { tool: 'patch.apply', parentCommandId: parent },
      at: Date.now(),
    });
    const args = { files: [{ path: 'file.txt', beforeHash: contentHash('fixture data'), after: 'updated' }] };
    const request = { ...f.request, commandId: id(), tool: 'patch.apply', args, argsHash: hash(args) };
    await assert.rejects(
      f.manager.tool(request, new AbortController().signal),
      (e) => e.code === 'EXECUTION_UNCERTAIN',
    );
    assert.equal(f.counters.executions, 0);
    assert.equal(f.counters.claims, 0);
  } finally {
    f.close();
  }
});
