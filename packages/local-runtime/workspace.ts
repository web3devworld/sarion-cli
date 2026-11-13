import { executable, cleanEnvironment, nullDevice } from '../platform/process.ts';
import { matches } from '../agent-protocol/validation.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type * as P from '../agent-protocol/contracts.ts';
import { assert, contentHash, id, Failure } from '../agent-protocol/validation.ts';
import { home, privateDir } from '../platform/config.ts';
export const helper = fileURLToPath(
  new URL(
    fs.existsSync(new URL('./fs-helper.py', import.meta.url)) ? './fs-helper.py' : '../platform/fs-helper.py',
    import.meta.url,
  ),
);
export class WorkspaceManager implements P.WorkspaceManager {
  private identities = new Map<string, string>();
  private exclusions: string[] = [];
  setExclusions(paths: string[]): void {
    assert(paths.length <= 100 && paths.every((p) => typeof p === 'string'), 'Invalid project exclusions');
    this.exclusions = paths;
  }
  async open(root: string, boundary: P.Boundary): Promise<P.WorkspaceHandle> {
    root = fs.realpathSync(root);
    const st = fs.lstatSync(root);
    assert(st.isDirectory(), 'Workspace is not a directory');
    let ident = st.dev + ':' + st.ino;
    if (process.platform === 'win32') {
      const probe = spawnSync(
        executable('python3'),
        [helper.replace('fs-helper.py', 'fs-windows.py'), 'fs'],
        {
          input: JSON.stringify({ root, op: 'identity' }),
          encoding: 'utf8',
          env: cleanEnvironment(),
          timeout: 10000,
        },
      );
      const result = JSON.parse(probe.stdout || '{}');
      assert(
        probe.status === 0 && result.ok && typeof result.result === 'string',
        'Windows workspace identity unavailable',
        'CAPABILITY_MISSING',
        7,
      );
      ident = result.result;
    }
    this.identities.set(root, ident);
    return {
      id:
        contentHash(boundary.id + root + ident).slice(0, 8) +
        '-' +
        contentHash(root).slice(0, 4) +
        '-4abc-8abc-' +
        contentHash(root + boundary.id).slice(0, 12),
      root,
      revision: ident,
      boundaryId: boundary.id,
    };
  }
  call(w: P.WorkspaceHandle, input: Record<string, unknown>): any {
    assert(
      ['linux', 'darwin', 'win32'].includes(process.platform),
      'Unsupported filesystem platform',
      'CAPABILITY_MISSING',
      7,
    );
    const r = spawnSync(
      executable('python3'),
      [process.platform === 'win32' ? helper.replace('fs-helper.py', 'fs-windows.py') : helper, 'fs'],
      {
        input: JSON.stringify({ root: w.root, identity: w.revision, ...input }),
        encoding: 'utf8',
        env: cleanEnvironment(),
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15000,
      },
    );
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      throw new Failure('WORKSPACE_ACCESS', 'Filesystem helper unavailable', 7);
    }
    assert(r.status === 0 && out.ok, out.error ?? 'Filesystem access refused', 'POLICY_DENIED', 4);
    return out.result;
  }
  async resolve(w: P.WorkspaceHandle, relative: string, action: 'read' | 'write'): Promise<P.AuthorizedPath> {
    assert(
      relative &&
        !path.isAbsolute(relative) &&
        !relative.split(/[\\/]/).some((x) => !x || x === '..' || x === '.'),
      'Invalid relative path',
      'POLICY_DENIED',
      4,
    );
    const canonical = path.join(w.root, relative);
    if (action === 'read') this.call(w, { op: 'read', path: relative });
    return { relative, canonical, identity: w.revision };
  }
  async verify(w: P.WorkspaceHandle, paths: P.AuthorizedPath[]): Promise<void> {
    const st = fs.lstatSync(w.root);
    if (process.platform === 'win32') this.call(w, { op: 'validate', path: 'identity-probe' });
    else assert(st.dev + ':' + st.ino === w.revision, 'Workspace replaced', 'POLICY_DENIED', 4);
    for (const p of paths) assert(p.identity === w.revision, 'Stale file identity', 'POLICY_DENIED', 4);
  }
  async lock(w: P.WorkspaceHandle, _executor: string): Promise<{ release(): Promise<void> }> {
    privateDir(home());
    const c = spawn(
      executable('python3'),
      [
        process.platform === 'win32' ? helper.replace('fs-helper.py', 'fs-windows.py') : helper,
        'lock',
        path.join(home(), 'workspace-' + contentHash(w.root) + '.lock'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnvironment() },
    );
    await new Promise<void>((resolve, reject) => {
      c.stdout.once('data', () => resolve());
      c.once('error', reject);
      c.once('exit', (code) => {
        if (code !== null)
          reject(new Failure('WORKSPACE_BUSY', 'Workspace already owned or lock unavailable', 5));
      });
    });
    return {
      async release() {
        c.stdin.end();
        await new Promise<void>((r) => {
          if (c.exitCode !== null) r();
          else c.once('exit', () => r());
        });
      },
    };
  }
  read(w: P.WorkspaceHandle, p: string): string {
    this.validatePath(w, p);
    return this.call(w, { op: 'read', path: p });
  }
  validatePath(w: P.WorkspaceHandle, p: string): void {
    this.call(w, { op: 'validate', path: p });
    assert(
      !this.exclusions.some((x) => matches(x, p) || p.startsWith(x + '/')),
      'Project exclusion',
      'POLICY_DENIED',
      4,
    );
    const ignored = spawnSync(executable('git'), ['-c', 'core.fsmonitor=false', 'check-ignore', '--', p], {
      cwd: w.root,
      env: cleanEnvironment(),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert(ignored.status !== 0, 'Ignored file', 'POLICY_DENIED', 4);
  }
  search(w: P.WorkspaceHandle, query: string, files = this.files(w)): any {
    return this.call(w, { op: 'search', query, files });
  }
  files(w: P.WorkspaceHandle): string[] {
    const files: string[] = this.call(w, { op: 'list' });
    const ignored = spawnSync(
      executable('git'),
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + nullDevice, 'check-ignore', '--stdin', '-z'],
      {
        cwd: w.root,
        input: files.join('\0') + '\0',
        encoding: 'utf8',
        env: cleanEnvironment(),
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (ignored.status === 128) {
      assert(
        !fs.existsSync(path.join(w.root, '.gitignore')),
        'Cannot enforce ignore rules without Git',
        'CAPABILITY_MISSING',
        7,
      );
      return files;
    }
    assert(ignored.status === 0 || ignored.status === 1, 'Ignore rules failed', 'POLICY_DENIED', 4);
    const excluded = new Set(ignored.stdout.split('\0'));
    return files.filter(
      (f) => !excluded.has(f) && !this.exclusions.some((p) => matches(p, f) || f.startsWith(p + '/')),
    );
  }
}
export class ContextProvider implements P.ContextProvider {
  constructor(
    private wm: WorkspaceManager,
    private exclusions: string[] = [],
  ) {}
  async collect(w: P.WorkspaceHandle, paths: string[], consentId: string): Promise<P.ContextChunk[]> {
    if (!paths.length) return [];
    const files = this.wm.files(w);
    const selected = files.filter(
      (f) =>
        paths.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')) &&
        !this.exclusions.some((p) => f === p || f.startsWith(p + '/')),
    );
    assert(selected.length <= 100, 'Select fewer files', 'CONTEXT_TOO_LARGE', 2);
    const out: P.ContextChunk[] = [];
    let total = 0;
    for (const p of selected) {
      const text = this.wm.read(w, p);
      total += Buffer.byteLength(text);
      assert(total <= 256 * 1024, 'Context exceeds 256 KiB', 'CONTEXT_TOO_LARGE', 2);
      out.push({
        path: p,
        sha256: contentHash(text),
        content: text,
        revision: w.revision,
        origin: 'repository',
        trust: 'untrusted-data',
        classification: 'project',
        consentId,
      });
    }
    return out;
  }
  async incremental(previous: P.ContextRef[], chunks: P.ContextChunk[]): Promise<P.ContextChunk[]> {
    return chunks.filter(
      (c) => !previous.some((p) => p.path === c.path && p.sha256 === c.sha256 && p.revision === c.revision),
    );
  }
  async fit(chunks: P.ContextChunk[], tokens: number): Promise<P.ContextChunk[]> {
    const bytes = chunks.reduce((s, c) => s + Buffer.byteLength(c.content), 0);
    assert(Math.ceil(bytes / 3) <= tokens, 'Context token budget exceeded', 'CONTEXT_TOO_LARGE', 2);
    return chunks;
  }
}
