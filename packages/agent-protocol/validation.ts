import { createHash, randomUUID } from 'node:crypto';
export const id = randomUUID;
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  throw new Failure('INVALID_REQUEST', 'Non-JSON value', 2);
}
export const hash = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
export const contentHash = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
export class Failure extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 1,
    public uncertain = false,
  ) {
    super(message);
  }
}
export function assert(ok: unknown, message: string, code = 'INVALID_REQUEST', exit = 2): asserts ok {
  if (!ok) throw new Failure(code, message, exit);
}
export function clean(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function redact(s: string): string {
  return clean(s)
    .replace(/(?:sar_cli_|sk-)[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

export function matches(pattern: string, value: string): boolean {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$').test(value);
}
