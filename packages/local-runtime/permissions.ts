import { matches } from '../agent-protocol/validation.ts';
export { matches } from '../agent-protocol/validation.ts';
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../agent-protocol/contracts.ts';
import { hash, id, assert, Failure, clean } from '../agent-protocol/validation.ts';
export interface Policy {
  schemaVersion: 1;
  boundaryId: string;
  workspaceRoot: string;
  expiresAt: string;
  tools: string[];
  writePaths: string[];
  denyPaths: string[];
  uploadPaths: string[];
  commands: { file: string; argvPrefix: string[]; argvTail: string[]; network: 'deny' }[];
  maxSteps: number;
  maxWallMs: number;
  production: false;
  auditRequired: true;
}
export interface Plan extends P.EffectPlan {
  tool: string;
  args: any;
  preview?: unknown;
}
export function loadPolicy(file: string, root: string): Policy {
  const absolute = fs.realpathSync(file);
  assert(!absolute.startsWith(root + path.sep), 'Automation policy must be outside repository', 'POLICY_DENIED', 4);
  const st = fs.lstatSync(absolute);
  assert(
    st.isFile() &&
      !st.isSymbolicLink() &&
      (process.platform === 'win32' || st.uid === 0 || st.uid === process.getuid?.()) &&
      (process.platform === 'win32' || (st.mode & 0o022) === 0),
    'Unsafe policy permissions',
    'POLICY_DENIED',
    4,
  );
  const p = JSON.parse(fs.readFileSync(absolute, 'utf8')) as Policy;
  assert(
    p.schemaVersion === 1 &&
      p.production === false &&
      p.auditRequired === true &&
      Array.isArray(p.tools) &&
      Array.isArray(p.denyPaths) &&
      Array.isArray(p.commands) &&
      Array.isArray(p.writePaths) &&
      Array.isArray(p.uploadPaths) &&
      Number.isInteger(p.maxSteps) &&
      p.maxSteps > 0 &&
      p.maxSteps <= 30 &&
      p.maxWallMs > 0 &&
      p.maxWallMs <= 1200000,
    'Invalid automation policy',
    'POLICY_DENIED',
    4,
  );
  assert(
    Date.parse(p.expiresAt) > Date.now() && fs.realpathSync(p.workspaceRoot) === root,
    'Expired or wrong workspace policy',
    'POLICY_DENIED',
    4,
  );
  return p;
}
export class PermissionEngine implements P.PermissionEngine {
  private prompts = new Map<string, string>();
  private grants = new Map<string, { grant: P.LocalGrant; plan: Plan }>();
  readonly revision: string;
  constructor(
    public workspace: P.WorkspaceHandle,
    public policies: Policy[] = [],
    private readPolicies: () => Policy[] = () => policies,
  ) {
    this.revision = hash(policies);
  }
  private issue(plan: Plan): P.LocalGrant {
    const grant: P.LocalGrant = {
      id: id(),
      planHash: plan.hash,
      workspaceId: plan.workspaceId,
      policyRevision: this.revision,
      expiresAt: Date.now() + 300000,
      actions: plan.actions,
    };
    this.grants.set(grant.id, { grant, plan });
    return grant;
  }
  private allowed(p: Policy, a: Plan): boolean {
    if (
      p.boundaryId !== this.workspace.boundaryId ||
      Date.parse(p.expiresAt) <= Date.now() ||
      !p.tools.includes(a.tool)
    )
      return false;
    if (a.paths.some((f) => p.denyPaths.some((d) => matches(d, f)))) return false;
    if (a.actions.includes('read') && a.paths.some((f) => !p.uploadPaths.some((d) => matches(d, f)))) return false;
    if (a.actions.includes('write') && a.paths.some((f) => !p.writePaths.some((d) => matches(d, f)))) return false;
    if (a.actions.some((x) => ['network', 'production', 'destructive'].includes(x))) return false;
    if (
      a.actions.includes('execute') &&
      !p.commands.some(
        (c) =>
          c.file === a.executable &&
          c.network === 'deny' &&
          a.argv?.length === c.argvPrefix.length + c.argvTail.length &&
          c.argvPrefix.every((x, i) => a.argv![i] === x) &&
          c.argvTail.every((x, i) => matches(x, a.argv![c.argvPrefix.length + i])),
      )
    )
      return false;
    return true;
  }
  contextPaths(paths: string[]): string[] {
    return paths.filter((f) =>
      this.policies.every((p) => p.uploadPaths.some((d) => matches(d, f)) && !p.denyPaths.some((d) => matches(d, f))),
    );
  }
  async evaluate(input: P.EffectPlan, mode: P.Mode): Promise<P.Decision> {
    const p = input as Plan;
    assert(
      p.workspaceId === this.workspace.id && hash({ ...p, hash: '' }) === p.hash,
      'Invalid effect plan',
      'POLICY_DENIED',
      4,
    );
    const rules = this.readPolicies();
    assert(hash(rules) === this.revision, 'Policy changed; restart task', 'POLICY_DENIED', 4);
    if (rules.some((r) => !this.allowed(r, p))) return { kind: 'deny', reason: 'Managed/task policy denies action' };
    if (p.actions.some((a) => a === 'network' || a === 'production'))
      return { kind: 'deny', reason: 'Network/production execution is unavailable in this preview' };
    const read = p.actions.every((a) => a === 'read');
    if (mode === 'trusted-automation') {
      if (!rules.length) return { kind: 'deny', reason: 'Automation requires a protected explicit policy' };
      return { kind: 'allow', grant: this.issue(p) };
    }
    if (read) return { kind: 'allow', grant: this.issue(p) };
    if (mode === 'read-only') return { kind: 'deny', reason: 'Read-only mode' };
    if (mode === 'workspace-write' && p.actions.every((a) => a === 'write'))
      return { kind: 'allow', grant: this.issue(p) };
    const request = {
      id: id(),
      commandId: p.commandId,
      actionHash: p.hash,
      summary: clean(JSON.stringify({ tool: p.tool, args: p.args, preview: p.preview ?? null })),
      actions: p.actions,
      expiresAt: Date.now() + 300000,
    };
    this.prompts.set(request.id, p.hash);
    return { kind: 'prompt', request };
  }
  async approve(r: P.ApprovalRequest, p: P.EffectPlan, choice: 'allow-once' | 'deny'): Promise<P.Decision> {
    assert(
      hash({ ...p, hash: '' }) === p.hash &&
        this.prompts.get(r.id) === p.hash &&
        r.commandId === p.commandId &&
        r.actionHash === p.hash &&
        r.expiresAt > Date.now(),
      'Approval expired/changed',
      'POLICY_DENIED',
      4,
    );
    this.prompts.delete(r.id);
    if (choice === 'deny') return { kind: 'deny', reason: 'User denied action' };
    assert(hash(this.readPolicies()) === this.revision, 'Policy changed', 'POLICY_DENIED', 4);
    return { kind: 'allow', grant: this.issue(p as Plan) };
  }
  async validate(g: P.LocalGrant, p: P.EffectPlan): Promise<void> {
    const old = this.grants.get(g.id);
    assert(
      old &&
        old.grant === g &&
        g.planHash === p.hash &&
        g.expiresAt > Date.now() &&
        hash({ ...p, hash: '' }) === p.hash &&
        hash(this.readPolicies()) === this.revision,
      'Grant invalid, expired or changed',
      'POLICY_DENIED',
      4,
    );
  }
}
/** A completed deny decision, distinct from malformed/changed policy failures. */
export class PermissionDenied extends Failure {
  constructor(reason: string) { super('POLICY_DENIED', reason, 4); }
}
export class ApprovalController {
  constructor(
    private engine: PermissionEngine,
    private prompt: (message: string) => Promise<boolean>,
    private nonInteractive = false,
  ) {}
  async authorize(plan: Plan, mode: P.Mode): Promise<P.LocalGrant> {
    let d = await this.engine.evaluate(plan, mode);
    if (d.kind === 'prompt') {
      if (this.nonInteractive) throw new Failure('APPROVAL_REQUIRED', 'Approval required; resume interactively', 4);
      const allow = await this.prompt(d.request.summary + '\nAllow once? [y/N] ');
      d = await this.engine.approve(d.request, plan, allow ? 'allow-once' : 'deny');
    }
    if (d.kind === 'deny') throw new PermissionDenied(d.reason);
    if (d.kind !== 'allow') throw new Failure('APPROVAL_REQUIRED', 'Approval required', 4);
    return d.grant;
  }
}
