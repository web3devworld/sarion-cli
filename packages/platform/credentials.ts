import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { atomic, home, privateDir } from './config.ts';
import { assert, Failure } from '../agent-protocol/validation.ts';
export interface Secrets {
  tokens: Record<string, string>;
  journalKeys: Record<string, string>;
}
const empty = (): Secrets => ({ tokens: {}, journalKeys: {} });
export class CredentialStore {
  constructor(
    private passphrase?: string,
    private platform = process.platform,
  ) {}
  private file = path.join(home(), 'vault.json');
  private command(file: string, args: string[], input?: string): string {
    const p = spawnSync(file, args, {
      input,
      encoding: 'utf8',
      env:
        this.platform === 'win32'
          ? {
              SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
              PATH:
                (process.env.SystemRoot ?? 'C:\\Windows') +
                '\\System32\\WindowsPowerShell\\v1.0;' +
                (process.env.SystemRoot ?? 'C:\\Windows') +
                '\\System32',
              USERPROFILE: process.env.USERPROFILE ?? '',
            }
          : { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '' },
      maxBuffer: 1024 * 1024,
      timeout: 20000,
    });
    if (p.status === 1 && args[0] === 'lookup' && p.stdout === '') return '';
    if (args[0] === 'find-generic-password' && /could not be found/i.test(p.stderr)) return '';
    if (p.status !== 0)
      throw new Failure(
        'KEYCHAIN_UNAVAILABLE',
        'OS credential storage unavailable; explicitly select encrypted storage',
        3,
      );
    return p.stdout.trim();
  }
  read(): Secrets {
    if (this.passphrase) {
      if (!fs.existsSync(this.file)) return empty();
      const st = fs.lstatSync(this.file);
      assert(
        st.isFile() && !st.isSymbolicLink() && (process.platform === 'win32' || (st.mode & 0o077) === 0),
        'Unsafe vault file',
      );
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      try {
        const key = scryptSync(this.passphrase, Buffer.from(v.salt, 'hex'), 32);
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'hex'));
        d.setAuthTag(Buffer.from(v.tag, 'hex'));
        return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data, 'base64')), d.final()]).toString());
      } catch {
        throw new Failure('VAULT_LOCKED', 'Cannot unlock credential store', 3);
      }
    }
    try {
      let value = '';
      if (this.platform === 'linux')
        value = this.command('/usr/bin/secret-tool', [
          'lookup',
          'application',
          'sarion-v2',
          'store',
          'credentials',
        ]);
      else if (this.platform === 'darwin')
        value = this.command('/usr/bin/security', [
          'find-generic-password',
          '-s',
          'sarion-v2',
          '-a',
          'credentials',
          '-w',
        ]);
      else if (this.platform === 'win32') {
        if (!fs.existsSync(this.file)) return empty();
        const st = fs.lstatSync(this.file);
        assert(st.isFile() && !st.isSymbolicLink(), 'Unsafe DPAPI vault');
        value = this.command(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$v=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString $v; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}`,
          ],
          fs.readFileSync(this.file, 'utf8'),
        );
      } else throw new Failure('KEYCHAIN_UNAVAILABLE', 'Unsupported OS credential store', 3);
      return value ? JSON.parse(Buffer.from(value, 'base64').toString()) : empty();
    } catch (e) {
      if (e instanceof Failure && e.code === 'KEYCHAIN_UNAVAILABLE') throw e;
      throw new Failure('KEYCHAIN_UNAVAILABLE', 'Credential storage is unavailable or damaged', 3);
    }
  }
  write(value: Secrets): void {
    privateDir(home());
    const text = JSON.stringify(value);
    if (this.passphrase) {
      assert(this.passphrase.length >= 12, 'Vault passphrase must have at least 12 characters');
      const salt = randomBytes(16),
        iv = randomBytes(12),
        key = scryptSync(this.passphrase, salt, 32),
        c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(text), c.final()]);
      atomic(
        this.file,
        JSON.stringify({
          version: 1,
          salt: salt.toString('hex'),
          iv: iv.toString('hex'),
          tag: c.getAuthTag().toString('hex'),
          data: data.toString('base64'),
        }),
      );
      return;
    }
    const encoded = Buffer.from(text).toString('base64');
    if (this.platform === 'linux')
      this.command(
        '/usr/bin/secret-tool',
        ['store', '--label=Sarion v2 credentials', 'application', 'sarion-v2', 'store', 'credentials'],
        encoded,
      );
    else if (this.platform === 'darwin')
      this.command(
        '/usr/bin/security',
        ['-i'],
        `add-generic-password -U -s sarion-v2 -a credentials -w ${encoded}\n`,
      );
    else if (this.platform === 'win32') {
      const encrypted = this.command(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::In.ReadToEnd() | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString',
        ],
        encoded,
      );
      atomic(this.file, encrypted);
    } else
      throw new Failure(
        'KEYCHAIN_UNAVAILABLE',
        'Use explicit encrypted storage on this platform in the preview',
        3,
      );
  }
  token(key: string): string {
    const injected = process.env.SARION_TOKEN;
    if (injected)
      assert(
        process.env.SARION_TOKEN_PROFILE === key,
        'Environment token must be explicitly bound with SARION_TOKEN_PROFILE=profile@endpoint',
        'UNAUTHENTICATED',
        3,
      );
    const token = injected || this.read().tokens[key];
    assert(token, 'Run sarion login first', 'UNAUTHENTICATED', 3);
    return token;
  }
  put(key: string, token: string): void {
    const s = this.read();
    s.tokens[key] = token;
    s.journalKeys[key] ??= randomBytes(32).toString('hex');
    this.write(s);
  }
  remove(key: string): void {
    const s = this.read();
    delete s.tokens[key];
    this.write(s);
  }
  key(key: string): Buffer {
    const s = this.read();
    if (!s.journalKeys[key]) {
      s.journalKeys[key] = randomBytes(32).toString('hex');
      this.write(s);
    }
    return Buffer.from(s.journalKeys[key], 'hex');
  }
}
