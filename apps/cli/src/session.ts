import type * as P from '../../../packages/agent-protocol/contracts.ts';
import { id, hash, assert, Failure } from '../../../packages/agent-protocol/validation.ts';
import { CortexClient } from '../../../packages/cortex-client/index.ts';
import { RecoveryJournal } from '../../../packages/local-runtime/journal.ts';
import { WorkspaceManager } from '../../../packages/local-runtime/workspace.ts';
import { LocalToolRegistry } from '../../../packages/local-runtime/tools.ts';
import { ApprovalController, PermissionDenied, type Plan } from '../../../packages/local-runtime/permissions.ts';
export class CliSessionManager implements P.CliSessionManager {
  snapshot?: P.SessionSnapshot;
  private executorId: string;
  private cursor = 0;
  constructor(
    public client: CortexClient,
    public journal: RecoveryJournal,
    public workspace: P.WorkspaceHandle,
    public wm: WorkspaceManager,
    public tools: LocalToolRegistry,
    public approvals: ApprovalController,
    public mode: P.Mode,
    private notify: (event: P.AgentEvent) => void,
  ) {
    this.executorId = journal.get<string>('executor') ?? id();
    journal.put('executor', this.executorId);
  }
  async open(input: P.OpenSession, _credential: P.CredentialHandle): Promise<P.SessionSnapshot> {
    const key = 'opening:' + hash(input);
    const pending = this.journal.get<P.OpenSession>(key) ?? input;
    this.journal.put(key, pending);
    const s = await this.client.open(pending);
    this.bind(s);
    return s;
  }
  private bind(s: P.SessionSnapshot): void {
    assert(s.boundary.id === this.workspace.boundaryId, 'Session endpoint changed', 'TENANT_MISMATCH', 3);
    const key = 'session:' + s.sessionId;
    const saved = this.journal.get<any>(key);
    const binding = {
      profile: this.client.profile.url,
      principal: s.principal,
      workspaceId: this.workspace.id,
      root: this.workspace.root,
    };
    assert(
      !saved || hash(saved.binding) === hash(binding),
      'Session principal/workspace mismatch',
      'TENANT_MISMATCH',
      3,
    );
    this.snapshot = s;
    this.cursor = this.journal.get<number>('cursor:' + s.sessionId) ?? 0;
    this.journal.put(key, { binding, snapshot: s });
  }
  async resume(id: string, w: P.WorkspaceHandle): Promise<P.SessionSnapshot> {
    assert(w.id === this.workspace.id, 'Wrong workspace');
    const s = await this.client.snapshot(id);
    this.bind(s);
    this.cursor = 0;
    this.journal.put('cursor:' + id, 0);
    return s;
  }
  async submit(command: P.SubmitCommand): Promise<P.Accepted> {
    assert(this.snapshot, 'No session');
    await this.journal.append({
      id: id(),
      commandId: command.commandId,
      state: 'submitted',
      body: command as unknown as P.Json,
      at: Date.now(),
    });
    this.journal.put('root:' + this.snapshot.sessionId, command.commandId);
    const accepted = await this.client.submit(this.snapshot.sessionId, command);
    await this.journal.transition(command.commandId, 'submitted', 'accepted', command as unknown as P.Json);
    return accepted;
  }
  async tool(request: P.ToolRequest, signal: AbortSignal): Promise<void> {
    assert(this.snapshot, 'No active session');
    const session = this.snapshot.sessionId;
    const existing = await this.journal.receipt(request.commandId);
    if (existing) {
      const claim = this.journal.get<any>('claim:' + request.commandId);
      const ack = await this.client.receipt(existing, claim?.executionToken);
      assert(ack.receiptHash === existing.receiptHash, 'Receipt ACK conflict', 'EXECUTION_UNCERTAIN', 5);
      this.journal.ack(request.commandId, ack.receiptHash);
      return;
    }
    let old = this.journal.record(request.commandId);
    const recorded = await this.client.status(session, request.commandId);
    if ((!old || old.state === 'acked') && recorded.execution?.state === 'recorded') {
      assert(
        recorded.execution.argsHash === request.argsHash,
        'Remote receipt identity changed',
        'EXECUTION_UNCERTAIN',
        5,
      );
      this.journal.audit(request.commandId, 'remote_recorded_no_execution');
      return;
    }
    if (old && ['claim_pending', 'claimed', 'executing', 'uncertain'].includes(old.state))
      throw new Failure(
        'EXECUTION_UNCERTAIN',
        'Tool ' + request.commandId + ' requires reconciliation; never automatically replayed',
        5,
        true,
      );
    if (!old) {
      await this.journal.append({
        id: id(),
        commandId: request.commandId,
        state: 'proposed',
        body: request as unknown as P.Json,
        at: Date.now(),
      });
      old = this.journal.record(request.commandId)!;
    }
    const plan = await this.tools.plan(request, this.workspace);
    if (plan.actions.some((a) => a !== 'read')) {
      const unresolved = (await this.journal.pending()).filter(
        (r) =>
          r.commandId !== request.commandId && ['claim_pending', 'claimed', 'executing', 'uncertain'].includes(r.state),
      );
      for (const entry of unresolved) {
        const prior = entry.body as unknown as P.ToolRequest;
        if (
          prior?.tool &&
          !['fs.read', 'fs.list', 'fs.search', 'git.status', 'git.diff'].includes(prior.tool) &&
          !this.journal.get('disposition:' + prior.parentCommandId)
        )
          throw new Failure(
            'EXECUTION_UNCERTAIN',
            'An earlier workspace effect needs reconciliation/disposition before another mutation',
            5,
            true,
          );
      }
    }
    let grant: P.LocalGrant;
    try {
      grant = await this.approvals.authorize(plan, this.mode);
    } catch (e) {
      this.journal.audit(
        request.commandId,
        e instanceof Failure && e.code === 'APPROVAL_REQUIRED' ? 'awaiting_approval' : 'denied',
      );
      if (e instanceof PermissionDenied) {
        const body: Omit<P.ExecutionReceipt, 'receiptHash'> = {
          receiptId: id(), sessionId: session, commandId: request.commandId,
          parentCommandId: request.parentCommandId, claimId: id(), executorId: this.executorId,
          argsHash: request.argsHash, workspaceId: this.workspace.id,
          policyRevision: request.policyRevision, approvalDecisionId: null,
          state: 'denied', startedAt: null, endedAt: Date.now(), exitCode: null,
          signal: null, output: null, effects: [],
          result: { code: e.code, message: e.message, executed: false },
          evidence: ['policy-denied-before-claim'],
        };
        const receipt = { ...body, receiptHash: hash(body) };
        this.journal.storeReceipt(receipt);
        const ack = await this.client.receipt(receipt);
        assert(ack.receiptHash === receipt.receiptHash, 'Receipt ACK mismatch', 'EXECUTION_UNCERTAIN', 5);
        this.journal.ack(request.commandId, ack.receiptHash);
        return;
      }
      throw e;
    }
    this.journal.put('plan:' + grant.id, plan);
    this.journal.put('approval:' + grant.id, {
      commandId: request.commandId,
      actionHash: plan.hash,
      policyRevision: grant.policyRevision,
      expiresAt: grant.expiresAt,
    });
    await this.client.approve(session, {
      id: grant.id,
      commandId: request.commandId,
      actionHash: plan.hash,
      decision: 'allow-once',
      localDecisionId: grant.id,
      policyRevision: request.policyRevision,
    });
    this.journal.audit(request.commandId, 'authorized');
    const claimId = id();
    const claimRequest: P.ClaimRequest = {
      claimId,
      executorId: this.executorId,
      argsHash: request.argsHash,
      approvalDecisionId: grant.id,
      policyRevision: request.policyRevision,
    };
    await this.journal.transition(request.commandId, 'proposed', 'claim_pending', request as unknown as P.Json);
    const claim = await this.client.claim(session, request.commandId, claimRequest);
    assert(claim.granted, 'Execution claim not granted; reconcile', 'EXECUTION_UNCERTAIN', 5);
    this.journal.put('claim:' + request.commandId, claim);
    await this.journal.transition(request.commandId, 'claim_pending', 'claimed', request as unknown as P.Json);
    const remote = await this.client.status(session, request.commandId);
    assert(
      remote.execution?.state === 'claimed' && remote.execution.executorId === this.executorId,
      'Claim revoked or changed',
      'EXECUTION_UNCERTAIN',
      5,
    );
    const parent = await this.client.status(session, request.parentCommandId);
    assert(parent.state === 'awaiting_tool', 'Parent is cancelled/unavailable', 'EXECUTION_UNCERTAIN', 5);
    let receipt: P.ExecutionReceipt;
    try {
      receipt = await this.tools.execute(request, grant, signal);
    } catch (e) {
      const r: Omit<P.ExecutionReceipt, 'receiptHash'> = {
        receiptId: id(),
        sessionId: session,
        commandId: request.commandId,
        parentCommandId: request.parentCommandId,
        claimId,
        executorId: this.executorId,
        argsHash: request.argsHash,
        workspaceId: this.workspace.id,
        policyRevision: request.policyRevision,
        approvalDecisionId: grant.id,
        state: 'uncertain',
        startedAt: null,
        endedAt: Date.now(),
        exitCode: null,
        signal: null,
        output: null,
        effects: [],
        result: { error: 'Execution could not be confirmed' },
        evidence: [],
      };
      receipt = { ...r, receiptHash: hash(r) };
    }
    receipt = {
      ...receipt,
      sessionId: session,
      parentCommandId: request.parentCommandId,
      claimId,
      executorId: this.executorId,
      argsHash: request.argsHash,
      policyRevision: request.policyRevision,
      approvalDecisionId: grant.id,
    };
    const { receiptHash: _, ...body } = receipt;
    receipt.receiptHash = hash(body);
    this.journal.storeReceipt(receipt);
    const ack = await this.client.receipt(receipt, claim.executionToken);
    assert(ack.receiptHash === receipt.receiptHash, 'Receipt ACK mismatch', 'EXECUTION_UNCERTAIN', 5);
    this.journal.ack(request.commandId, ack.receiptHash);
    if (receipt.state === 'uncertain')
      throw new Failure('EXECUTION_UNCERTAIN', 'Tool outcome unknown; receipt preserved', 5, true);
  }
  async *consume(signal: AbortSignal): AsyncIterable<P.AgentEvent> {
    assert(this.snapshot, 'No session');
    const session = this.snapshot.sessionId;
    const root = this.snapshot.active[0]?.commandId ?? this.journal.get<string>('root:' + session);
    assert(root, 'No active command');
    let terminal = false;
    for (let pulls = 0; pulls < 100 && !terminal; pulls++) {
      let progress = false;
      for await (const event of this.client.events(session, this.cursor, signal)) {
        if (event.t === 'tool_request') {
          await this.tool(event.request, signal);
          progress = true;
        }
        if (event.cursor !== null) {
          this.cursor = Math.max(this.cursor, event.cursor);
          this.journal.put('cursor:' + session, this.cursor);
        }
        if (event.t === 'result' && event.body.commandId === root) {
          terminal = ['committed', 'failed', 'cancelled', 'uncertain', 'abandoned'].includes(event.body.state);
          if (terminal) {
            const rec = this.journal.record(root);
            if (rec)
              this.journal.db.prepare('UPDATE records SET state=? WHERE command_id=?').run(event.body.state, root);
          }
        }
        this.notify(event);
        yield event;
      }
      if (!terminal) {
        const status = await this.client.status(session, root);
        if (['committed', 'failed', 'cancelled', 'uncertain', 'abandoned'].includes(status.state)) {
          const event: P.AgentEvent = {
            v: '1.0',
            t: 'result',
            body: status,
            status: status.state === 'committed' ? 200 : 409,
            sessionId: session,
            commandId: root,
            eventId: id(),
            cursor: null,
            revision: status.revision,
          };
          this.notify(event);
          yield event;
          terminal = true;
        } else if (!progress && status.state !== 'accepted')
          throw new Failure('TURN_UNRESOLVED', 'Task remains ' + status.state + '; use recover/resume', 5, true);
      }
    }
    assert(terminal, 'Task polling bound reached', 'TURN_UNRESOLVED', 5);
  }
  async cancel(commandId: string): Promise<P.CommandSnapshot> {
    assert(this.snapshot, 'No session');
    this.journal.audit(commandId, 'cancel_requested');
    return this.client.cancel(this.snapshot.sessionId, { cancelId: id(), commandId, reason: 'user' });
  }
  async recover(sessionId: string): Promise<P.CommandSnapshot[]> {
    await this.resume(sessionId, this.workspace);
    for (const r of this.journal.outbox().filter((r) => r.sessionId === sessionId)) {
      const claim = this.journal.get<any>('claim:' + r.commandId);
      const ack = await this.client.receipt(r, claim?.executionToken);
      assert(ack.receiptHash === r.receiptHash, 'Receipt ACK mismatch', 'EXECUTION_UNCERTAIN', 5);
      this.journal.ack(r.commandId, ack.receiptHash);
    }
    const s = await this.client.snapshot(sessionId);
    const root = this.journal.get<string>('root:' + sessionId);
    if (root && !s.active.some((x) => x.commandId === root)) {
      const local = this.journal.record(root);
      if (local && !['committed', 'acked', 'abandoned'].includes(local.state)) {
        try {
          return [...s.active, await this.client.status(sessionId, root)];
        } catch {
          return [
            ...s.active,
            {
              sessionId,
              commandId: root,
              parentCommandId: null,
              state: 'uncertain',
              revision: s.revision,
              conversationSeq: s.conversationSeq,
              result: null,
              unresolvedTools: [],
              usage: null,
              execution: null,
              error: {
                code: 'TURN_UNRESOLVED',
                message: 'Local submission has no confirmed remote result; it was not repeated',
                commandId: root,
                retry: 'read-status',
                retryAfterMs: null,
              },
            },
          ];
        }
      }
    }
    return s.active;
  }
}
