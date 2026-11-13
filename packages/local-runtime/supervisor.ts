import fs from 'node:fs';
import os from 'node:os';
import { cleanEnvironment, macSandbox, sandboxSupport } from '../platform/process.ts';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type * as P from '../agent-protocol/contracts.ts';
import { hash, id, assert, contentHash, redact, Failure } from '../agent-protocol/validation.ts';
import { PermissionEngine, matches, type Plan } from './permissions.ts';
import { RecoveryJournal } from './journal.ts';
export const environment = cleanEnvironment;
export class ExecutionSupervisor implements P.ExecutionSupervisor {
  private children = new Map<string, ChildProcess>();
  private stops = new Map<string, () => void>();
  constructor(
    private workspace: P.WorkspaceHandle,
    private journal: RecoveryJournal,
    private permissions: PermissionEngine,
  ) {}
  static available(): boolean {
    return sandboxSupport().available;
  }
  static sandbox(root: string, file: string, argv: string[], git = false, denies: string[] = []): string[] {
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/lib',
      '/lib',
    ];
    if (fs.existsSync('/lib64')) args.push('--ro-bind', '/lib64', '/lib64');
    if (!file.startsWith('/usr/')) {
      assert(
        file === fs.realpathSync(process.execPath) && !file.startsWith(root + path.sep),
        'Only the installed CLI runtime can be mounted outside /usr',
        'POLICY_DENIED',
        4,
      );
      args.push('--ro-bind', file, file);
    }
    args.push(
      '--symlink',
      'usr/bin',
      '/bin',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--ro-bind',
      root,
      '/workspace',
      '--chdir',
      '/workspace',
    );
    let entries = 0;
    const visit = (dir: string, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        assert(++entries <= 100000, 'Sandbox filesystem inspection limit reached', 'POLICY_DENIED', 4);
        const r = rel + e.name,
          p = path.join(dir, e.name);
        if (
          denies.some((d) => matches(d, r) || matches(d, r + '/')) ||
          [
            '.git',
            '.sarion',
            '.ssh',
            '.aws',
            '.gnupg',
            '.kube',
            '.npmrc',
            '.netrc',
            '.pypirc',
            '.git-credentials',
            'credentials.json',
            'secrets.json',
          ].includes(e.name) ||
          e.name.startsWith('.env') ||
          e.name.startsWith('id_rsa') ||
          e.name.startsWith('id_ed25519') ||
          ['cli.json', 'providers.json'].includes(e.name) ||
          /\.(pem|key|p12|pfx)$/.test(e.name)
        ) {
          if (git && e.name === '.git' && e.isDirectory()) {
            args.push('--bind', p, '/workspace/' + r);
            continue;
          }
          if (e.isDirectory()) args.push('--tmpfs', '/workspace/' + r);
          else args.push('--ro-bind', '/dev/null', '/workspace/' + r);
        } else if (e.isDirectory()) visit(p, r + '/');
      }
    };
    visit(root);
    return [
      ...args,
      '--',
      '/usr/bin/prlimit',
      '--nproc=128',
      '--nofile=256',
      '--cpu=600',
      '--',
      file,
      ...argv,
    ];
  }
  async run(input: P.EffectPlan, g: P.LocalGrant, signal: AbortSignal): Promise<P.ExecutionReceipt> {
    const p = input as Plan;
    await this.permissions.validate(g, p);
    assert(ExecutionSupervisor.available(), sandboxSupport().reason, 'CAPABILITY_MISSING', 7);
    assert(p.networkOrigins.length === 0, 'Network execution not supported', 'POLICY_DENIED', 4);
    assert(p.executable && path.isAbsolute(p.executable) && p.argv, 'Explicit executable/argv required');
    const temp =
      process.platform === 'darwin' ? fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-exec-')) : null;
    const args = temp
      ? macSandbox(
          this.workspace.root,
          p.executable,
          p.argv,
          fs.realpathSync(temp),
          p.tool.startsWith('git.'),
          this.permissions.policies.flatMap((p) => p.denyPaths),
        )
      : ExecutionSupervisor.sandbox(
          this.workspace.root,
          p.executable,
          p.argv,
          p.tool.startsWith('git.'),
          this.permissions.policies.flatMap((p) => p.denyPaths),
        );
    if (!temp && p.args.cwd && p.args.cwd !== '.') {
      const at = args.indexOf('--');
      args.splice(at, 0, '--chdir', '/workspace/' + p.args.cwd);
    }
    const started = Date.now();
    assert(!this.children.has(p.commandId), 'Command already running', 'EXECUTION_UNCERTAIN', 5);
    const old = this.journal.record(p.commandId);
    assert(old?.state === 'claimed', 'Execution must have a durable claim', 'EXECUTION_UNCERTAIN', 5);
    await this.journal.transition(p.commandId, 'claimed', 'executing', old.body);
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      let killed = false,
        spawnError = false,
        settled = false;
      const child = spawn(temp ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap', args, {
        cwd: path.join(this.workspace.root, String(p.args.cwd ?? '.')),
        env: {
          ...environment(),
          ...(temp ? { TMPDIR: temp, HOME: temp } : {}),
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.children.set(p.commandId, child);
      const stop = () => {
        killed = true;
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {}
        const t = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {}
        }, 3000);
        t.unref();
      };
      this.stops.set(p.commandId, stop);
      const timeout = setTimeout(stop, p.timeoutMs);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      const capture = (b: Buffer) => {
        const prior = bytes;
        bytes += b.length;
        if (prior < p.maxOutputBytes) chunks.push(b.subarray(0, p.maxOutputBytes - prior));
      };
      child.stdout!.on('data', capture);
      child.stderr!.on('data', capture);
      child.once('error', () => {
        spawnError = true;
      });
      child.once('close', (exitCode, term) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', stop);
        this.children.delete(p.commandId);
        this.stops.delete(p.commandId);
        if (temp) fs.rmSync(temp, { recursive: true, force: true });
        const output = redact(Buffer.concat(chunks).toString('utf8'));
        const state: P.ExecutionReceipt['state'] =
          killed || spawnError || term !== null ? 'uncertain' : exitCode === 0 ? 'succeeded' : 'failed-known';
        const r: Omit<P.ExecutionReceipt, 'receiptHash'> = {
          receiptId: id(),
          sessionId: '',
          commandId: p.commandId,
          parentCommandId: '',
          claimId: '',
          executorId: '',
          argsHash: '',
          workspaceId: p.workspaceId,
          policyRevision: this.permissions.revision,
          approvalDecisionId: null,
          state,
          startedAt: started,
          endedAt: Date.now(),
          exitCode,
          signal: term,
          output: {
            sha256: contentHash(output),
            excerpt: output.slice(0, 60000),
            bytes,
            truncated: bytes > 60000,
          },
          effects: [],
          result: { exitCode },
          evidence: [],
        };
        resolve({ ...r, receiptHash: hash(r) });
      });
    });
  }
  async cancel(c: string): Promise<{ terminated: boolean; effectsKnown: boolean }> {
    const p = this.children.get(c);
    if (!p) return { terminated: false, effectsKnown: false };
    this.stops.get(c)?.();
    return { terminated: false, effectsKnown: false };
  }
  async reconcile(c: string): Promise<P.ExecutionReceipt | null> {
    return this.journal.receipt(c);
  }
}
