import type * as P from '../agent-protocol/contracts.ts';
import { id, hash, contentHash, assert, Failure } from '../agent-protocol/validation.ts';
import { WorkspaceManager } from './workspace.ts';
import { RecoveryJournal } from './journal.ts';
import { PermissionEngine, type Plan } from './permissions.ts';
export class PatchManager implements P.PatchManager {
  constructor(
    private wm: WorkspaceManager,
    private workspace: P.WorkspaceHandle,
    private journal: RecoveryJournal,
    private permission: PermissionEngine,
  ) {}
  async prepare(w: P.WorkspaceHandle, files: P.PatchFile[]): Promise<P.PatchPlan> {
    assert(files.length > 0 && files.length <= 32, 'Patch must contain 1–32 files');
    assert(new Set(files.map((f) => f.path)).size === files.length, 'Duplicate patch path');
    for (const f of files) {
      this.wm.validatePath(w, f.path);
      let before: string | null = null;
      try {
        before = this.wm.read(w, f.path);
      } catch (e) {
        if (f.beforeHash !== null) throw e; // helper will still validate protected/new path on apply
      }
      assert(
        (before === null ? null : contentHash(before)) === f.beforeHash,
        'Stale patch base',
        'REVISION_CONFLICT',
        5,
      );
      assert(f.after === null || Buffer.byteLength(f.after) <= 65536, 'Patch too large');
    }
    const body = { id: id(), files, workspaceId: w.id };
    return { ...body, hash: hash(body) };
  }
  private saved(plan: P.PatchPlan): any[] {
    return plan.files.map((f) => ({
      path: f.path,
      before: f.beforeHash === null ? null : this.wm.read(this.workspace, f.path),
      after: f.after,
    }));
  }
  async checkpoint(plan: P.PatchPlan): Promise<P.Checkpoint> {
    const cp = { id: plan.id, workspaceId: plan.workspaceId, manifestHash: plan.hash, commandId: plan.id };
    this.journal.put('patch:' + plan.id, { plan, files: this.saved(plan), applied: [] });
    await this.journal.checkpoint(cp);
    return cp;
  }
  async apply(plan: P.PatchPlan, g: P.LocalGrant): Promise<P.ExecutionReceipt> {
    const effect = this.journal.get<Plan>('plan:' + g.id);
    assert(effect, 'No authorized patch plan', 'POLICY_DENIED', 4);
    await this.permission.validate(g, effect);
    assert(plan.hash === effect.args.patch.hash, 'Patch changed after approval', 'POLICY_DENIED', 4);
    const cp = await this.checkpoint(plan);
    this.journal.put('checkpoint:' + cp.id, { ...cp, commandId: effect.commandId, createdAt: Date.now() });
    const effects: P.ExecutionReceipt['effects'] = [];
    try {
      for (const f of plan.files) {
        effects.push(this.wm.call(this.workspace, { op: 'apply', ...f }));
        this.journal.put('patch-progress:' + plan.id, effects);
      }
      return this.receipt(effect, effects, 'succeeded');
    } catch (e) {
      this.journal.put('patch-uncertain:' + plan.id, { effects, error: String(e) });
      throw new Failure(
        'EXECUTION_UNCERTAIN',
        'Patch may be partially applied; use recover/checkpoint inspection',
        5,
        true,
      );
    }
  }
  private receipt(
    p: Plan,
    effects: P.ExecutionReceipt['effects'],
    state: P.ExecutionReceipt['state'],
  ): P.ExecutionReceipt {
    const r = {
      receiptId: id(),
      sessionId: '',
      commandId: p.commandId,
      parentCommandId: '',
      claimId: '',
      executorId: '',
      argsHash: '',
      workspaceId: p.workspaceId,
      policyRevision: this.permission.revision,
      approvalDecisionId: null,
      state,
      startedAt: Date.now(),
      endedAt: Date.now(),
      exitCode: 0,
      signal: null,
      output: null,
      effects,
      result: { changed: effects.length },
      evidence: [],
    };
    return { ...r, receiptHash: hash(r) };
  }
  async restore(cp: P.Checkpoint, g: P.LocalGrant): Promise<P.ExecutionReceipt> {
    const saved = this.journal.get<any>('patch:' + cp.id);
    assert(saved, 'Unknown checkpoint');
    const files = saved.files.map((f: any) => ({
      path: f.path,
      beforeHash: f.after === null ? null : contentHash(f.after),
      after: f.before,
    }));
    const effect = this.journal.get<Plan>('plan:' + g.id);
    assert(
      effect?.args?.patch && hash(effect.args.patch.files) === hash(files),
      'Restore grant does not match checkpoint',
      'POLICY_DENIED',
      4,
    );
    return this.apply(effect.args.patch, g);
  }
  async reconcile(planId: string): Promise<'applied' | 'not-applied' | 'partial' | 'unknown'> {
    const saved = this.journal.get<any>('patch:' + planId);
    if (!saved) return 'unknown';
    let before = 0,
      after = 0;
    for (const f of saved.files) {
      let text = null;
      try {
        text = this.wm.read(this.workspace, f.path);
      } catch {}
      const h = text === null ? null : contentHash(text);
      if (h === (f.after === null ? null : contentHash(f.after))) after++;
      else if (h === (f.before === null ? null : contentHash(f.before))) before++;
      else return 'unknown';
    }
    return after === saved.files.length ? 'applied' : before === saved.files.length ? 'not-applied' : 'partial';
  }
}
