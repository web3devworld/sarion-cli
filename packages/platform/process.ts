import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, matches } from '../agent-protocol/validation.ts';

export function executable(name: 'git' | 'python3'): string {
  const override = name === 'python3' ? process.env.SARION_PYTHON : process.env.SARION_GIT;
  if (override) {
    assert(
      path.isAbsolute(override) &&
        !path.resolve(override).startsWith(process.cwd() + path.sep) &&
        fs.existsSync(override),
      'Helper override must be an absolute installed path outside the workspace',
      'POLICY_DENIED',
      4,
    );
    return fs.realpathSync(override);
  }
  if (process.platform !== 'win32') return '/usr/bin/' + name;
  const candidates =
    name === 'git'
      ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe')]
      : [
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python313', 'python.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe'),
        ];
  // Never search the repository/current directory for executable helpers.
  const found = candidates.find((p) => path.isAbsolute(p) && fs.existsSync(p));
  assert(found, `Install ${name} in its documented native location`, 'CAPABILITY_MISSING', 7);
  return found;
}
export const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
export function cleanEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.platform === 'win32' ? path.dirname(executable('git')) : '/usr/local/bin:/usr/bin:/bin',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}),
    HOME: process.platform === 'win32' ? (process.env.TEMP ?? 'C:\\Windows\\Temp') : '/tmp',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  };
}
export function macSandbox(
  root: string,
  file: string,
  argv: string[],
  temp: string,
  git = false,
  denies: string[] = [],
): string[] {
  const q = (s: string) => JSON.stringify(s);
  const denied: string[] = [];
  let entries = 0;
  const visit = (dir: string, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      assert(++entries <= 100000, 'Sandbox filesystem inspection limit reached', 'POLICY_DENIED', 4);
      const r = rel + e.name,
        p = path.join(dir, e.name);
      if (denies.some((d) => matches(d, r) || matches(d, r + '/'))) denied.push(p);
      else if (e.isDirectory() && e.name !== '.git') visit(p, r + '/');
    }
  };
  if (denies.length) visit(root);
  // No network or general Mach IPC grant. Unsupported host versions fail closed.
  const profile = `(version 1)(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-map-executable (subpath "/usr") (subpath "/bin") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/private/var/db/dyld") (subpath "/Library/Apple") (subpath "/opt/homebrew") (literal ${q(file)}) (subpath ${q(root)}))
(allow file-read-metadata (path-ancestors ${q(root)}) (path-ancestors ${q(temp)}) (path-ancestors ${q(file)}) (literal "/") (literal "/var") (literal "/tmp") (literal "/etc"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow sysctl-read)
(allow file-read* file-test-existence (literal "/") (subpath "/usr") (subpath "/opt/homebrew") (subpath "/bin") (subpath "/sbin") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/private/var/db/dyld") (subpath "/Library/Apple") (literal "/dev/null") (literal "/dev/urandom") (literal ${q(file)}) (subpath ${q(root)}) (subpath ${q(temp)}))
(deny file-read* (regex #"(^|/)([.]env[^/]*|[.]ssh|[.]aws|[.]gnupg|[.]kube|[.]sarion|[.]npmrc|[.]netrc|[.]pypirc|id_rsa[^/]*|id_ed25519[^/]*|cli[.]json|providers[.]json|credentials[.]json|secrets[.]json)(/|$)"))
(deny file-read* (regex #"[.](pem|key|p12|pfx)$"))
${git ? `(allow file-write* (subpath ${q(path.join(root, '.git'))}))` : `(deny file-read* (subpath ${q(path.join(root, '.git'))}))`}
(allow file-write* (subpath ${q(temp)}) (literal "/dev/null"))
${denied.map((p) => `(deny file-read* file-write* (subpath ${q(p)}))`).join('\n')}`;
  return ['-p', profile, file, ...argv];
}
export function sandboxSupport(): { available: boolean; reason: string } {
  if (process.platform === 'win32')
    return {
      available: false,
      reason:
        'Native arbitrary processes and Git mutation require an audited AppContainer/Job Object helper. Use WSL2; file tools remain available.',
    };
  const available =
    process.platform === 'linux'
      ? fs.existsSync('/usr/bin/bwrap') && fs.existsSync('/usr/bin/prlimit')
      : process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
  return {
    available,
    reason: available
      ? 'Native sandbox installed; run native qualification before release'
      : 'Required native sandbox unavailable',
  };
}
