import { assert, Failure } from '../../../packages/agent-protocol/validation.ts';
export interface Args {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}
const bool = new Set([
  'help',
  'version',
  'token',
  'stdin',
  'non-interactive',
  'no-color',
  'local-only',
  'plan',
  'accept-edits',
  'encrypted-store',
  'development',
  'share-context',
]);
const valued = new Set([
  'profile',
  'project',
  'model',
  'effort',
  'verbosity',
  'format',
  'permission-mode',
  'timeout',
  'session',
  'policy',
  'budget',
  'url',
  'boundary',
  'remote-project',
  'bundle',
  'exclude',
  'abandon',
  'conversation',
]);
export function parse(argv: string[]): Args {
  const flags: Args['flags'] = {},
    pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--yes') throw new Failure('ARGUMENT', '--yes was removed; use trusted-automation with --policy', 2);
    if (a === '-p') {
      pos.unshift('agent');
      flags['legacy-p'] = true;
      continue;
    }
    if (a === '-c') {
      flags.resume = true;
      continue;
    }
    if (a === '-h') {
      flags.help = true;
      continue;
    }
    if (a === '-v') {
      flags.version = true;
      continue;
    }
    if (a.startsWith('--')) {
      const [key, ...value] = a.slice(2).split('=');
      if (key === 'attach' || key === 'exclude') {
        const v = value.join('=') || argv[++i];
        assert(v && !v.startsWith('--'), '--attach needs a path');
        (flags[key] ??= []) as string[];
        (flags[key] as string[]).push(v);
      } else if (key === 'resume') {
        const v = value.join('=');
        flags.resume = v || (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
      } else if (bool.has(key)) {
        assert(!value.length, 'Boolean flag does not take value');
        flags[key] = true;
      } else {
        assert(valued.has(key), 'Unknown flag --' + key);
        const v = value.join('=') || argv[++i];
        assert(v && !v.startsWith('--'), 'Missing value for --' + key);
        flags[key] = v;
      }
    } else if (a.startsWith('-')) throw new Failure('ARGUMENT', 'Unknown option ' + a, 2);
    else pos.push(a);
  }
  const command = pos.shift() ?? 'chat';
  assert(!flags['legacy-p'] || flags['permission-mode'], '-p requires explicit --permission-mode');
  if (flags.format) assert(['text', 'json', 'ndjson'].includes(String(flags.format)), 'Invalid output format');
  if (flags['permission-mode'])
    assert(
      ['read-only', 'workspace-write', 'approval-required', 'trusted-automation'].includes(
        String(flags['permission-mode']),
      ),
      'Invalid permission mode',
    );
  if (flags.model)
    assert(['chat', 'ask', 'agent', 'models'].includes(command), '--model is not valid for this command');
  return { command, positionals: pos, flags };
}
