import { sandboxSupport } from '../platform/process.ts';
import { validateInput } from '../agent-protocol/schema.ts';
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../agent-protocol/contracts.ts';
import { id, hash, contentHash, assert, redact, Failure } from '../agent-protocol/validation.ts';
import { PermissionEngine, type Plan } from './permissions.ts';
import { WorkspaceManager } from './workspace.ts';
import { PatchManager } from './patch.ts';
import { ExecutionSupervisor } from './supervisor.ts';
import { RecoveryJournal } from './journal.ts';
import { GitAdapter } from './git.ts';
const text = { type: 'string' },
  paths = { type: 'array', items: text };
const obj = (properties: any, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const TOOL_SCHEMAS: Record<string, any> = {
  'fs.read': obj({ path: text }),
  'fs.list': obj({
    directory: {
      type: 'string',
      description: "Repository-relative directory; use '.' for root. Empty string is also root.",
    },
  }),
  'fs.search': obj({ query: text }),
  'patch.apply': obj({
    files: {
      type: 'array',
      items: obj({
        path: text,
        beforeHash: { type: ['string', 'null'] },
        after: { type: ['string', 'null'] },
      }),
    },
  }),
  'process.run': obj({
    file: text,
    argv: paths,
    cwd: text,
    timeoutMs: { type: 'number' },
    network: { const: 'deny', enum: ['deny'], type: 'string',
      description: "Must be 'deny': the sandbox blocks all network access." },
  }),
  'git.status': obj({}),
  'git.diff': obj({ paths }),
  'git.stage': obj({ paths }),
  'git.commit': obj({ message: text }),
};
export class LocalToolRegistry implements P.LocalToolRegistry {
  readonly patch: PatchManager;
  readonly supervisor: ExecutionSupervisor;
  readonly git: GitAdapter;
  constructor(
    public wm: WorkspaceManager,
    public workspace: P.WorkspaceHandle,
    public journal: RecoveryJournal,
    public permission: PermissionEngine,
  ) {
    this.supervisor = new ExecutionSupervisor(workspace, journal, permission);
    this.patch = new PatchManager(wm, workspace, journal, permission);
    this.git = new GitAdapter(this.supervisor, () => permission.contextPaths(wm.files(workspace)), workspace);
  }
  descriptors(): P.ToolDescriptor[] {
    return Object.entries(TOOL_SCHEMAS)
      .filter(
        ([name]) => sandboxSupport().available || !['process.run', 'git.stage', 'git.commit'].includes(name),
      )
      .map(([name, inputSchema]) => ({
        name,
        version: '1',
        inputSchema,
        actions:
          name.startsWith('fs.') || ['git.status', 'git.diff'].includes(name)
            ? ['read']
            : name === 'patch.apply'
              ? ['write']
              : name.startsWith('git.')
                ? ['git-history', 'execute']
                : ['execute'],
        retryClass:
          name.startsWith('fs.') || ['git.status', 'git.diff'].includes(name) ? 'read' : 'non-idempotent',
      }));
  }
  async plan(r: P.ToolRequest, w: P.WorkspaceHandle): Promise<Plan> {
    assert(
      r.workspaceId === w.id &&
        r.expectedWorkspaceRevision === w.revision &&
        hash(r.args) === r.argsHash &&
        r.expiresAt > Date.now(),
      'Tool identity, workspace or expiry mismatch',
      'POLICY_DENIED',
      4,
    );
    assert(r.toolVersion === '1' && r.tool in TOOL_SCHEMAS, 'Unknown tool/version', 'CAPABILITY_MISSING', 7);
    validateInput(TOOL_SCHEMAS[r.tool], r.args);
    const a = r.args as any;
    let plan: Plan = {
      commandId: r.commandId,
      workspaceId: w.id,
      hash: '',
      tool: r.tool,
      args: a,
      actions: ['read'],
      paths: [],
      networkOrigins: [],
      timeoutMs: 120000,
      maxOutputBytes: 1048576,
    };
    if (r.tool === 'fs.read') {
      assert(typeof a.path === 'string', 'Invalid file path');
      plan.paths = [a.path];
      await this.wm.resolve(w, a.path, 'read');
    } else if (r.tool === 'fs.list') {
      assert(
        typeof a.directory === 'string' && !a.directory.includes('..') && !path.isAbsolute(a.directory),
        'Invalid directory',
      );
      plan.args = { ...a, directory: a.directory || '.' };
    } else if (r.tool === 'fs.search')
      assert(
        typeof a.query === 'string' && a.query.length > 0 && a.query.length <= 1000,
        'Search query required',
      );
    else if (r.tool === 'patch.apply') {
      const patch = await this.patch.prepare(w, a.files);
      plan.args = { patch };
      plan.paths = patch.files.map((f) => f.path);
      plan.actions = patch.files.some((f) => f.after === null) ? ['write', 'destructive'] : ['write'];
      plan.preview = patch.files.map((f) => ({
        path: f.path,
        before: f.beforeHash === null ? null : this.wm.read(w, f.path),
        after: f.after,
      }));
    } else if (r.tool === 'process.run') {
      assert(sandboxSupport().available, sandboxSupport().reason, 'CAPABILITY_MISSING', 7);
      assert(
        typeof a.file === 'string' &&
          path.isAbsolute(a.file) &&
          Array.isArray(a.argv) &&
          a.argv.every((x: unknown) => typeof x === 'string') &&
          a.argv.length <= 100 &&
          a.network === 'deny',
        'Explicit argv/network required',
      );
      const executable = fs.realpathSync(a.file);
      assert(
        (executable.startsWith('/usr/') ||
          executable === fs.realpathSync(process.execPath) ||
          (process.platform === 'darwin' && executable.startsWith('/opt/homebrew/'))) &&
          !/\/(?:sudo|su|doas|pkexec|mount|umount|bwrap|unshare|nsenter|sh|bash|zsh|fish|powershell|pwsh|cmd)(?:\.exe)?$/.test(
            executable,
          ),
        'Executable denied',
        'POLICY_DENIED',
        4,
      );
      assert(
        a.cwd === '.' || (typeof a.cwd === 'string' && !a.cwd.includes('..') && !path.isAbsolute(a.cwd)),
        'Working directory outside workspace',
        'POLICY_DENIED',
        4,
      );
      const cwd = fs.realpathSync(path.join(w.root, a.cwd));
      assert(
        cwd === w.root || cwd.startsWith(w.root + path.sep),
        'Working directory escape',
        'POLICY_DENIED',
        4,
      );
      assert(Number.isInteger(a.timeoutMs) && a.timeoutMs > 0 && a.timeoutMs <= 600000, 'Invalid timeout');
      plan.executable = executable;
      plan.argv = a.argv;
      plan.timeoutMs = a.timeoutMs;
      plan.actions = ['execute'];
    } else if (['git.stage', 'git.commit'].includes(r.tool)) {
      const g = await this.git.plan(w, r.tool === 'git.stage' ? 'stage' : 'commit', r.args);
      plan = { ...g, commandId: r.commandId };
    }
    plan.hash = hash({ ...plan, hash: '' });
    return plan;
  }
  async execute(r: P.ToolRequest, g: P.LocalGrant, signal: AbortSignal): Promise<P.ExecutionReceipt> {
    const p = this.journal.get<Plan>('plan:' + g.id);
    assert(p && p.commandId === r.commandId, 'No prepared approved plan', 'POLICY_DENIED', 4);
    await this.permission.validate(g, p);
    if (p.actions.includes('execute'))
      return p.tool.startsWith('git.') ? this.git.execute(p, g, signal) : this.supervisor.run(p, g, signal);
    const old = this.journal.record(r.commandId);
    assert(old?.state === 'claimed', 'Tool has no durable claim', 'EXECUTION_UNCERTAIN', 5);
    await this.journal.transition(r.commandId, 'claimed', 'executing', old.body);
    if (p.tool === 'patch.apply') return this.patch.apply(p.args.patch, g);
    let result: any;
    if (p.tool === 'fs.read') {
      const content = this.wm.read(this.workspace, p.args.path);
      result = {
        path: p.args.path,
        content: redact(content),
        sha256: contentHash(content),
      };
    } else if (p.tool === 'fs.list') {
      result = {
        files: this.permission
          .contextPaths(this.wm.files(this.workspace))
          .filter((f) => p.args.directory === '.' || f.startsWith(p.args.directory.replace(/\/$/, '') + '/'))
          .slice(0, 500),
      };
    } else if (p.tool === 'fs.search') {
      const found = this.wm.search(
        this.workspace,
        p.args.query,
        this.permission.contextPaths(this.wm.files(this.workspace)),
      );
      result = {
        ...found,
        matches: found.matches.map((hit: any) => ({
          ...hit,
          text: redact(hit.text),
        })),
      };
    } else if (p.tool === 'git.status') result = await this.git.inspect(this.workspace);
    else if (p.tool === 'git.diff') result = { diff: await this.git.diff(this.workspace, p.args.paths) };
    else throw new Failure('CAPABILITY_MISSING', 'Unknown handler', 7);
    const receipt: Omit<P.ExecutionReceipt, 'receiptHash'> = {
      receiptId: id(),
      sessionId: '',
      commandId: r.commandId,
      parentCommandId: r.parentCommandId,
      claimId: '',
      executorId: '',
      argsHash: r.argsHash,
      workspaceId: r.workspaceId,
      policyRevision: r.policyRevision,
      approvalDecisionId: null,
      state: 'succeeded',
      startedAt: Date.now(),
      endedAt: Date.now(),
      exitCode: 0,
      signal: null,
      output: null,
      effects: [],
      result,
      evidence: [],
    };
    return { ...receipt, receiptHash: hash(receipt) };
  }
}
