import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { macSandbox, cleanEnvironment, sandboxSupport } from './process.ts';
import { ExecutionSupervisor } from '../local-runtime/supervisor.ts';
/** A native execution probe, never a declaration that sandbox security passed. */
export function sandboxProbe(root: string): {
  available: boolean;
  verified: boolean;
  reason: string;
} {
  const support = sandboxSupport();
  if (!support.available) return { ...support, verified: false };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-probe-'));
  try {
    const mac = process.platform === 'darwin';
    const args = mac
      ? macSandbox(root, '/usr/bin/true', [], fs.realpathSync(temp))
      : ExecutionSupervisor.sandbox(root, '/usr/bin/true', []);
    const p = spawnSync(mac ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap', args, {
      env: cleanEnvironment(),
      timeout: 10000,
    });
    return {
      ...support,
      verified: p.status === 0,
      reason:
        p.status === 0
          ? support.reason
          : p.stderr?.toString().slice(0, 2000) ||
            'Native sandbox failed (status=' +
              p.status +
              ', signal=' +
              p.signal +
              ', error=' +
              p.error?.message +
              ')',
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
