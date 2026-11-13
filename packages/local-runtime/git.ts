import { executable, nullDevice } from '../platform/process.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type * as P from '../agent-protocol/contracts.ts';
import { assert, hash, id, redact, Failure } from '../agent-protocol/validation.ts';
import { environment, ExecutionSupervisor } from './supervisor.ts';
import type { Plan } from './permissions.ts';
export const gitBase = [
  '-c',
  'core.hooksPath=' + nullDevice,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
  '-c',
  'submodule.recurse=false',
  '-c',
  'protocol.file.allow=never',
];
export class GitAdapter implements P.GitAdapter {
  constructor(
    private supervisor: ExecutionSupervisor,
    private allowedFiles: () => string[],
    private workspace?: P.WorkspaceHandle,
  ) {}
  static read(w: P.WorkspaceHandle, args: string[], input?: string): string {
    const metadata = path.join(w.root, '.git');
    const st = fs.lstatSync(metadata);
    assert(
      st.isDirectory() && !st.isSymbolicLink(),
      'Git metadata must be a directory under the workspace; linked worktrees need separate qualification',
      'POLICY_DENIED',
      4,
    );
    assert(
      !fs.existsSync(path.join(metadata, 'objects', 'info', 'alternates')),
      'External Git object stores are denied',
      'POLICY_DENIED',
      4,
    );
    const p = spawnSync(
      executable('git'),
      ['--git-dir=' + metadata, '--work-tree=' + w.root, ...gitBase, ...args],
      {
        cwd: w.root,
        env: environment(),
        input,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      },
    );
    assert(
      !p.error && p.status === 0,
      'Git inspection failed (not a repository or unsafe configuration)',
      'GIT_ERROR',
      1,
    );
    return p.stdout;
  }
  async inspect(w: P.WorkspaceHandle): Promise<{ head: string | null; dirty: string[] }> {
    const text = GitAdapter.read(w, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
      '--ignore-submodules=all',
    ]);
    let head = null;
    try {
      head = GitAdapter.read(w, ['rev-parse', 'HEAD']).trim();
    } catch {}
    return {
      head,
      dirty: text
        .split('\n')
        .filter(Boolean)
        .filter((x) => !/(?:\.env|\.pem|\.key|\.ssh|\.aws)/.test(x)),
    };
  }
  async diff(w: P.WorkspaceHandle, paths: string[]): Promise<string> {
    const allowed = this.allowedFiles();
    const selected = paths.length ? paths.filter((p) => allowed.includes(p)) : allowed;
    assert(selected.length <= 5000, 'Diff file limit exceeded');
    if (!selected.length) return '';
    return redact(GitAdapter.read(w, ['diff', '--no-ext-diff', '--no-textconv', '--', ...selected])).slice(
      0,
      60000,
    );
  }
  async plan(
    w: P.WorkspaceHandle,
    action: 'stage' | 'commit' | 'push' | 'restore',
    input: P.Json,
  ): Promise<Plan> {
    const a = input as any;
    assert(
      ['stage', 'commit'].includes(action),
      'Push/destructive Git unavailable in this preview',
      'POLICY_DENIED',
      4,
    );
    const file = executable('git');
    let argv: string[];
    let paths: string[] = [];
    if (action === 'stage') {
      assert(
        Array.isArray(a.paths) &&
          a.paths.length &&
          a.paths.every((p: string) => this.allowedFiles().includes(p)),
        'Only permitted explicit paths can be staged',
        'POLICY_DENIED',
        4,
      );
      paths = a.paths;
      argv = [...gitBase, 'add', '--', ...paths];
    } else {
      assert(typeof a.message === 'string' && a.message.length <= 2000, 'Commit message required');
      const staged = GitAdapter.read(w, ['diff', '--cached', '--name-only', '-z'])
        .split('\0')
        .filter(Boolean);
      assert(
        staged.length > 0 && staged.every((p) => this.allowedFiles().includes(p)),
        'Staged changes include protected or unapproved paths',
        'POLICY_DENIED',
        4,
      );
      paths = staged;
      argv = [...gitBase, '-c', 'commit.gpgSign=false', 'commit', '--no-verify', '-m', a.message];
    }
    let filters: string[] = [];
    try {
      filters = GitAdapter.read(w, ['config', '--local', '--name-only', '--get-regexp', '^filter\\.'])
        .trim()
        .split('\n');
    } catch {}
    for (const key of filters) {
      if (!/^filter\.[a-zA-Z0-9_.-]+\.(clean|smudge|process|required)$/.test(key)) continue;
      const base = key.slice(0, key.lastIndexOf('.'));
      argv.unshift(
        '-c',
        base + '.process=',
        '-c',
        base + '.clean=/usr/bin/cat',
        '-c',
        base + '.smudge=/usr/bin/cat',
        '-c',
        base + '.required=false',
      );
    }
    const before = await this.inspect(w);
    const plan = {
      commandId: id(),
      hash: '',
      workspaceId: w.id,
      tool: 'git.' + action,
      args: a,
      actions: ['git-history', 'execute'] as P.Action[],
      paths,
      executable: file,
      argv,
      networkOrigins: [],
      timeoutMs: 120000,
      maxOutputBytes: 1048576,
      preview: before,
    };
    plan.hash = hash({ ...plan, hash: '' });
    return plan;
  }
  async execute(p: P.EffectPlan, g: P.LocalGrant, signal: AbortSignal): Promise<P.ExecutionReceipt> {
    const plan = p as Plan;
    const receipt = await this.supervisor.run(p, g, signal);
    const after = await this.inspect(this.workspace!);
    const before = (plan.preview as any)?.head ?? null;
    if (receipt.state !== 'succeeded' && after.head !== before) receipt.state = 'uncertain';
    receipt.result = {
      ...(receipt.result as object),
      headBefore: before,
      headAfter: after.head,
      dirtyAfter: after.dirty,
    };
    const { receiptHash, ...body } = receipt;
    receipt.receiptHash = hash(body);
    return receipt;
  }
}
