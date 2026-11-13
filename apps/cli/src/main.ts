import { detectTerm } from '../terminal/src/term.mjs';
import { makeStyle } from '../terminal/src/style.mjs';
import { MarkdownStream } from '../terminal/src/markdown.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parse } from './args.ts';
import type * as P from '../../../packages/agent-protocol/contracts.ts';
import {
  hash,
  id,
  assert,
  Failure,
  clean,
  redact,
  contentHash,
} from '../../../packages/agent-protocol/validation.ts';
import {
  loadConfig,
  saveConfig,
  profile,
  endpoint,
  home,
  privateDir,
  atomic,
} from '../../../packages/platform/config.ts';
import { CredentialStore } from '../../../packages/platform/credentials.ts';
import { AuthenticationProvider } from '../../../packages/platform/authentication.ts';
import { CortexClient } from '../../../packages/cortex-client/index.ts';
import { RecoveryJournal } from '../../../packages/local-runtime/journal.ts';
import { WorkspaceManager, ContextProvider } from '../../../packages/local-runtime/workspace.ts';
import {
  PermissionEngine,
  ApprovalController,
  loadPolicy,
  type Plan,
} from '../../../packages/local-runtime/permissions.ts';
import { ExecutionSupervisor } from '../../../packages/local-runtime/supervisor.ts';
import { LocalToolRegistry } from '../../../packages/local-runtime/tools.ts';
import { CliSessionManager } from './session.ts';
export const VERSION = '2.0.0-preview.2';
const rootForDoctor = () => fs.realpathSync(process.cwd());
const HELP = `SARION CLI v2 — protocol 1.0 (preview)\n\nsarion [chat] [--resume [id]] [--model auto|id]\nsarion ask <prompt> [--stdin] [--attach path] [--format json|ndjson]\nsarion agent <task> [--resume id] [--permission-mode mode] [--policy path]\nsarion login [--token] [--encrypted-store] | logout [--local-only] | whoami\nsarion account list|use <id> | tenant list|use <id>\nsarion session list|show|history|delete <id>\nsarion project init|status|files|search <text>|read <path>\nsarion models | usage | recover <session-id> [--abandon <command-id>]\nsarion checkpoint list|restore <id> | policy | audit [count] | sandbox doctor\nsarion config list|get <key>|set <key> <value>\nsarion endpoint list|add <name> --url URL --boundary cloud|sovereign|use <name>|doctor\n\nModes: read-only, workspace-write, approval-required, trusted-automation.\nAgent reads disclose selected project data to the endpoint: use --share-context\nor approve interactively; automation requires a protected external policy.\nAgent bounds: --max-steps N --max-tool-calls N --max-output-tokens N --max-context-tokens N\nPrivate profiles: endpoint add NAME --url URL --boundary sovereign --zero-egress [--addresses PRIVATE_IP,...]\nUse --offline with a private profile; login --enterprise reads an enterprise assertion from stdin.\nGlobal: --profile name --project path --format text|json|ndjson\n        --verbosity quiet|normal|verbose --non-interactive --timeout seconds\nCredentials: OS keychain; explicitly encrypted store uses SARION_VAULT_PASSPHRASE\n(12+ characters). No plaintext fallback. No --yes. No telemetry or auto-update.\nLocal file tools require Python3 + Git. Process isolation: Linux bubblewrap; macOS sandbox-exec; Windows processes denied (use WSL2).\n`;
async function stdin(limit = 262144): Promise<string> {
  let out = '';
  for await (const chunk of process.stdin) {
    out += chunk;
    assert(Buffer.byteLength(out) <= limit, 'Input too large');
  }
  return out;
}
async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return stdin(8192);
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (b: Buffer) => {
      for (const c of b.toString()) {
        if (c === '\u0003') {
          finish();
          reject(new Failure('INTERRUPTED', 'Interrupted', 130));
          return;
        }
        if (c === '\r' || c === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    process.stdin.on('data', onData);
  });
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parse(argv),
    f = args.flags,
    pos = args.positionals;
  let format = String(f.format ?? 'text');
  const output = (v: unknown) =>
    process.stdout.write(
      format === 'text'
        ? (typeof v === 'string' ? clean(v) : JSON.stringify(v, null, 2)) + '\n'
        : JSON.stringify(v) + '\n',
    );
  if (f.help || args.command === 'help') {
    output(HELP);
    return;
  }
  if (f.version || args.command === 'version') {
    output(VERSION);
    return;
  }
  const config = loadConfig(),
    name = String(f.profile ?? config.current);
  let selected = profile(config, name);
  if (f.offline)
    assert(
      selected.boundary === 'sovereign' && selected.zeroEgress,
      '--offline requires a sovereign zero-egress profile with private services',
      'POLICY_DENIED',
      4,
    );
  const nonInteractive = !!f['non-interactive'] || !process.stdin.isTTY;
  let rl: readline.Interface | undefined;
  const question = async (q: string): Promise<string> => {
    assert(!nonInteractive, 'Interactive confirmation required', 'APPROVAL_REQUIRED', 4);
    rl ??= readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    return rl.question(clean(q));
  };
  const confirm = async (q: string): Promise<boolean> => /^(y|yes)$/i.test((await question(q)).trim());
  try {
    if (args.command === 'endpoint') {
      const [sub, n] = pos;
      if (sub === 'list') {
        output(config.profiles);
        return;
      }
      if (sub === 'add') {
        assert(
          n && f.url && ['cloud', 'sovereign'].includes(String(f.boundary)),
          'Endpoint add requires name, --url and --boundary',
        );
        assert(!config.profiles[n], 'Profile already exists; select a new name');
        config.profiles[n] = {
          url: endpoint(String(f.url), !!f.development),
          boundary: f.boundary as any,
          ...(f['zero-egress']
            ? {
                zeroEgress: true,
                addresses: String(f.addresses ?? '')
                  .split(',')
                  .filter(Boolean),
              }
            : {}),
        };
        if (!config.profiles[n].addresses?.length) delete config.profiles[n].addresses;
        profile(config, n);
        saveConfig(config);
        output('Endpoint added; credentials and sessions are separate');
        return;
      }
      if (sub === 'use') {
        assert(config.profiles[n], 'Unknown profile');
        config.current = n;
        saveConfig(config);
        output('Selected ' + n + '; no conversation/context transferred');
        return;
      }
    }
    if (args.command === 'endpoint') assert(pos[0] === 'doctor', 'Use endpoint list|add|use|doctor');
    if (args.command === 'config') {
      const [sub, key, value] = pos;
      if (sub === 'list') {
        output(config.preferences);
        return;
      }
      if (sub === 'get') {
        output(key ? ((config.preferences as any)[key] ?? null) : config.preferences);
        return;
      }
      assert(
        sub === 'set' && ['model', 'verbosity'].includes(key) && typeof value === 'string',
        'Only model/verbosity are local preferences',
      );
      (config.preferences as any)[key] = value;
      saveConfig(config);
      output('Saved');
      return;
    }
    if (args.command === 'sandbox' || args.command === 'diagnostics') {
      assert(args.command === 'diagnostics' || pos[0] === 'doctor', 'Use sandbox doctor');
      const available = ExecutionSupervisor.available();
      const { sandboxProbe } = await import('../../../packages/platform/qualification.ts');
      const result = sandboxProbe(rootForDoctor());
      output({
        platform: process.platform,
        ...result,
        profile: name,
        boundary: selected.boundary,
        zeroEgress: !!selected.zeroEgress,
        publicNetworkAllowed: !selected.zeroEgress,
        executionConcurrency: 1,
      });
      if (!result.verified && args.command !== 'diagnostics') process.exitCode = 7;
      return;
    }
    const wm = new WorkspaceManager(),
      root = fs.realpathSync(String(f.project ?? process.cwd()));
    const localBoundary: P.Boundary = {
      id: selected.boundaryId ?? selected.url,
      kind: selected.boundary,
      issuer: selected.issuer ?? selected.url,
      audience: selected.audience ?? selected.url,
    };
    let workspace = await wm.open(root, localBoundary);
    if (args.command === 'project') {
      const [sub, text] = pos;
      if (sub === 'status') {
        output({
          root,
          workspaceId: workspace.id,
          profile: name,
          files: wm.files(workspace).length,
        });
        return;
      }
      if (sub === 'files') {
        output(wm.files(workspace));
        return;
      }
      if (sub === 'read') {
        assert(text, 'File path required');
        output(wm.read(workspace, text));
        return;
      }
      if (sub === 'search') {
        assert(text, 'Search text required');
        output(wm.search(workspace, text));
        return;
      }
      if (sub === 'init') {
        const target = path.join(root, '.sarion');
        if (fs.existsSync(target))
          assert(!fs.lstatSync(target).isSymbolicLink(), 'Unsafe project settings directory');
        assert(!fs.existsSync(path.join(target, 'project.json')), 'Project is already initialized');
        if (nonInteractive)
          assert(
            f['permission-mode'] === 'workspace-write',
            'Project init requires --permission-mode workspace-write in scripts',
            'APPROVAL_REQUIRED',
            4,
          );
        else
          assert(
            await confirm('Create .sarion/project.json in ' + root + '? [y/N] '),
            'Declined',
            'POLICY_DENIED',
            4,
          );
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        atomic(
          path.join(target, 'project.json'),
          JSON.stringify({ version: 1, exclude: [] }, null, 2) + '\n',
        );
        if (f['remote-project']) {
          selected.projectBindings ??= {};
          selected.projectBindings[contentHash(root)] = String(f['remote-project']);
          saveConfig(config);
        }
        output('Project initialized');
        return;
      }
      throw new Failure('ARGUMENT', 'Unknown project command', 2);
    }
    let pass = process.env.SARION_VAULT_PASSPHRASE;
    if (f['encrypted-store'] && !pass) pass = await secret('Encrypted store passphrase (12+ characters): ');
    const store = new CredentialStore(pass);
    const credentialKey = name + '@' + selected.url;
    if (args.command === 'login') {
      const provider = new AuthenticationProvider(
        selected,
        store,
        () => secret('Access token: '),
        (s) => process.stderr.write(clean(s) + '\n'),
      );
      await provider.login(credentialKey, f.enterprise ? 'enterprise' : f.token ? 'token' : 'device');
      selected.credentialExpiresAt = provider.expiresAt!;
      const c = new CortexClient(selected, () => store.token(credentialKey));
      const caps = await c.capabilities(AbortSignal.timeout(20000));
      selected.boundaryId = caps.boundary.id;
      selected.issuer = caps.boundary.issuer;
      selected.audience = caps.boundary.audience;
      selected.principal = {
        subject: caps.principal.subject,
        tenantId: caps.principal.tenantId,
        accountId: caps.principal.accountId,
      };
      saveConfig(config);
      output({ authenticated: true, profile: name, principal: caps.principal });
      return;
    }
    const client = new CortexClient(selected, () => store.token(credentialKey));
    if (args.command === 'logout') {
      let revoked = false;
      if (!f['local-only']) {
        try {
          await client.request('/auth/revoke', {});
          revoked = true;
        } catch (e) {
          process.stderr.write('Remote revocation could not be confirmed.\n');
        }
      }
      store.remove(credentialKey);
      output({
        localRemoved: true,
        remoteRevoked: revoked,
        revocationPending: !revoked,
      });
      if (!revoked && !f['local-only']) process.exitCode = 5;
      return;
    }
    const caps = await client.capabilities(AbortSignal.timeout(20000));
    workspace = await wm.open(root, caps.boundary);
    if (args.command === 'whoami' || args.command === 'endpoint') {
      output({
        profile: name,
        url: selected.url,
        principal: caps.principal,
        boundary: caps.boundary,
        protocol: caps.protocol,
        credentialExpiresAt: selected.credentialExpiresAt ?? null,
        reauthorization: 'sarion login --profile ' + name,
      });
      return;
    }
    if (args.command === 'models') {
      output({ default: caps.defaultModel, models: caps.models });
      return;
    }
    if (args.command === 'usage') {
      output(await client.request('/usage'));
      return;
    }
    if (['account', 'tenant'].includes(args.command)) {
      const plural = args.command === 'account' ? 'accounts' : 'tenants';
      const data = await client.request<any>('/' + plural);
      if (pos[0] === 'list') {
        output(data);
        return;
      }
      const current = args.command === 'account' ? caps.principal.accountId : caps.principal.tenantId;
      assert(
        pos[0] === 'use' && pos[1] === current,
        'The credential is bound to another principal; login a separate profile for that account/tenant',
        'TENANT_MISMATCH',
        3,
      );
      output({ selected: current });
      return;
    }
    let project: any = {};
    const settings = path.join(root, '.sarion', 'project.json');
    if (fs.existsSync(settings)) {
      assert(
        !fs.lstatSync(path.dirname(settings)).isSymbolicLink() && !fs.lstatSync(settings).isSymbolicLink(),
        'Unsafe project config',
      );
      project = JSON.parse(fs.readFileSync(settings, 'utf8'));
      assert(
        Object.keys(project).every((k) => ['version', 'exclude'].includes(k)),
        'Project cannot alter global execution policy',
      );
    }
    project.exclude = [
      ...(Array.isArray(project.exclude) ? project.exclude : []),
      ...(Array.isArray(f.exclude) ? f.exclude : []),
    ];
    project.remoteProjectId = f['remote-project'] ?? selected.projectBindings?.[contentHash(root)];
    wm.setExclusions(project.exclude);
    const verbosity = String(f.verbosity ?? config.preferences.verbosity);
    assert(['quiet', 'normal', 'verbose'].includes(verbosity), 'Invalid verbosity');
    const policies = [];
    const managed =
      process.platform === 'win32'
        ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Sarion', 'policy.json')
        : '/etc/sarion/policy.json';
    if (fs.existsSync(managed)) policies.push(loadPolicy(managed, root));
    if (f.policy) policies.push(loadPolicy(String(f.policy), root));
    const permission = new PermissionEngine(workspace, policies, () => {
      const all = [];
      if (fs.existsSync(managed)) all.push(loadPolicy(managed, root));
      if (f.policy) all.push(loadPolicy(String(f.policy), root));
      return all;
    });
    const mode = (
      f.plan
        ? 'read-only'
        : f['accept-edits']
          ? 'workspace-write'
          : (f['permission-mode'] ?? (args.command === 'agent' ? 'approval-required' : 'read-only'))
    ) as P.Mode;
    assert(
      mode !== 'trusted-automation' || policies.length,
      'Trusted automation requires --policy',
      'POLICY_DENIED',
      4,
    );
    const journalKey = store.key(credentialKey);
    const stateRoot = fs.realpathSync(home());
    assert(
      stateRoot !== root && !stateRoot.startsWith(root + path.sep),
      'Credential/recovery storage must be outside the workspace',
      'POLICY_DENIED',
      4,
    );
    const journal = new RecoveryJournal(
      path.join(
        home(),
        'state',
        hash({
          url: selected.url,
          principal: caps.principal,
          workspace: workspace.id,
        }),
      ),
      journalKey,
    );
    await journal.prune(Date.now());
    const tools = new LocalToolRegistry(wm, workspace, journal, permission);
    const approvals = new ApprovalController(permission, confirm, nonInteractive);
    let renderer = new MarkdownStream({
      style: makeStyle(
        detectTerm({
          flags: { noColor: !!f['no-color'] || format !== 'text' },
        }),
      ),
      write: (s: string) => process.stdout.write(s),
      columns: process.stdout.columns ?? 80,
    });
    let rendered = false;
    let final: P.CommandSnapshot | undefined;
    const notify = (e: P.AgentEvent) => {
      if (format === 'ndjson') output(e);
      if (format === 'text') {
        if (e.t === 'delta') {
          if (e.reset) {
            renderer.end();
            process.stderr.write('[provisional answer reset]\n');
          }
          renderer.push(clean(e.text ?? ''));
          rendered = true;
        }
        if (e.t === 'phase' && verbosity !== 'quiet') process.stderr.write(clean(e.phase) + '\n');
        if (e.t === 'tool_request' && verbosity !== 'quiet')
          process.stderr.write('Tool: ' + clean(e.request.tool) + '\n');
      }
      if (e.t === 'result') final = e.body;
    };
    const session = new CliSessionManager(client, journal, workspace, wm, tools, approvals, mode, notify);
    let lock: { release(): Promise<void> } | undefined;
    try {
      if (args.command === 'audit') {
        output(journal.audits(Number(pos[0]) || 20));
        return;
      }
      if (args.command === 'policy') {
        output({ mode, revision: permission.revision, policies });
        return;
      }
      if (args.command === 'checkpoint') {
        if (pos[0] === 'list') {
          output(journal.keys('checkpoint:').map((k) => journal.get(k)));
          return;
        }
        if (pos[0] === 'restore') {
          const cp = journal.get<P.Checkpoint>('checkpoint:' + pos[1]);
          assert(cp, 'Unknown checkpoint');
          const saved = journal.get<any>('patch:' + cp.id);
          const files = saved.files.map((f: any) => ({
            path: f.path,
            beforeHash: f.after === null ? null : contentHash(f.after),
            after: f.before,
          }));
          const req: P.ToolRequest = {
            commandId: id(),
            parentCommandId: id(),
            tool: 'patch.apply',
            toolVersion: '1',
            args: { files },
            argsHash: hash({ files }),
            workspaceId: workspace.id,
            expectedWorkspaceRevision: workspace.revision,
            policyRevision: permission.revision,
            expiresAt: Date.now() + 300000,
          };
          const plan = await tools.plan(req, workspace),
            grant = await approvals.authorize(plan, mode);
          journal.put('plan:' + grant.id, plan);
          await journal.append({
            id: id(),
            commandId: req.commandId,
            state: 'claimed',
            body: req as unknown as P.Json,
            at: Date.now(),
          });
          lock = await wm.lock(workspace, id());
          const receipt = await tools.execute(req, grant, AbortSignal.timeout(120000));
          journal.storeReceipt(receipt);
          journal.ack(receipt.commandId, receipt.receiptHash);
          output(receipt);
          return;
        }
        throw new Failure('ARGUMENT', 'Unknown checkpoint command', 2);
      }
      if (args.command === 'session') {
        const [sub, sid] = pos;
        if (sub === 'list') {
          output(await client.request('/sessions'));
          return;
        }
        assert(sid, 'Session ID required');
        if (sub === 'show') {
          output(await client.snapshot(sid));
          return;
        }
        if (sub === 'history') {
          output(await client.request('/sessions/' + sid + '/messages'));
          return;
        }
        if (sub === 'delete') {
          assert(
            f['local-only'] ||
              (!nonInteractive && (await confirm('Delete this remote conversation? [y/N] '))),
            'Explicit interactive deletion confirmation required',
            'APPROVAL_REQUIRED',
            4,
          );
          if (f['local-only'])
            throw new Failure(
              'UNSUPPORTED',
              'Local session deletion requires unresolved-evidence export; use remote deletion after recovery',
              7,
            );
          output(
            await client.request('/sessions/' + sid, { commandId: id(), scope: 'conversation' }, 'DELETE'),
          );
          return;
        }
      }
      if (args.command === 'recover') {
        assert(pos[0], 'Session ID required');
        const recovery = await session.recover(pos[0]);
        if (f.abandon) {
          assert(
            !nonInteractive &&
              (await confirm('Abandon command without claiming its effects were undone? [y/N] ')),
            'Abandonment requires explicit interactive disposition',
            'APPROVAL_REQUIRED',
            4,
          );
          output(
            await client.resolve(pos[0], {
              resolutionId: id(),
              commandId: String(f.abandon),
              disposition: 'abandon',
              evidence: ['user-disposition'],
              receiptHash: null,
            }),
          );
          journal.put('disposition:' + String(f.abandon), {
            kind: 'abandoned',
            at: Date.now(),
            note: 'Does not prove effects were undone',
          });
        } else
          output({
            remote: recovery,
            local: (await journal.pending()).map((r) => ({
              commandId: r.commandId,
              state: r.state,
            })),
            checkpoints: await Promise.all(
              journal.keys('checkpoint:').map(async (key) => {
                const cp = journal.get<P.Checkpoint>(key)!;
                return { ...cp, status: await tools.patch.reconcile(cp.id) };
              }),
            ),
          });
        return;
      }
      assert(['chat', 'ask', 'agent'].includes(args.command), 'Unknown command; use --help');
      if (args.command === 'agent') {
        assert(
          caps.features.localTools &&
            caps.features.continuations &&
            caps.features.executionClaims &&
            caps.features.durableReceipts,
          'Agent tools unavailable',
          'CAPABILITY_MISSING',
          7,
        );
        const shared =
          !!f['share-context'] ||
          policies.length > 0 ||
          (!nonInteractive &&
            (await confirm(
              'Allow selected endpoint ' +
                selected.url +
                ' to inspect nonsecret files in ' +
                root +
                ' through authorized tools? [y/N] ',
            )));
        assert(
          shared,
          'Project disclosure consent required (--share-context or explicit automation policy)',
          'APPROVAL_REQUIRED',
          4,
        );
        lock = await wm.lock(workspace, id());
      }
      const resume = f.session ?? f.resume;
      if (typeof resume === 'string') await session.resume(resume, workspace);
      else if (resume === true) {
        const candidates = journal
          .keys('session:')
          .map((k) => journal.get<any>(k))
          .filter((v) => v.binding.workspaceId === workspace.id);
        assert(candidates.length === 1, 'Resume is ambiguous; specify an exact session ID');
        await session.resume(candidates[0].snapshot.sessionId, workspace);
      } else
        await session.open(
          {
            openId: id(),
            ...(project.remoteProjectId ? { projectId: project.remoteProjectId } : {}),
            ...(f.conversation ? { conversationId: String(f.conversation) } : {}),
            workspace: {
              id: workspace.id,
              rootHash: contentHash(root),
              revision: workspace.revision,
            },
            level: args.command === 'agent' ? 'B' : 'A',
            mode,
            tools: args.command === 'agent' ? tools.descriptors() : [],
          },
          { id: credentialKey, profile: name },
        );
      if (verbosity !== 'quiet') process.stderr.write('Session: ' + session.snapshot!.sessionId + '\n');
      let first = true;
      for (;;) {
        const active = await client.snapshot(session.snapshot!.sessionId);
        let rootCommand = active.active[0]?.commandId;
        const taskMode = args.command === 'agent';
        let prompt = first ? pos.join(' ') : '';
        if (!rootCommand) {
          if (!prompt && args.command === 'chat') prompt = await question('sarion> ');
          if (prompt === '/exit' || prompt === '/quit') break;
          if (prompt === '/help') {
            output(HELP);
            first = false;
            continue;
          }
          if (prompt === '/usage') {
            output(await client.request('/usage'));
            first = false;
            continue;
          }
          if (prompt.startsWith('/model ')) {
            const chosen = prompt.slice(7).trim();
            assert(chosen === 'auto' || caps.models.some((m) => m.id === chosen), 'Unknown model');
            f.model = chosen;
            first = false;
            continue;
          }
          if (prompt.startsWith('/effort ')) {
            const chosen = prompt.slice(8).trim();
            assert(['low', 'medium', 'high', 'default'].includes(chosen), 'Invalid effort');
            f.effort = chosen;
            first = false;
            continue;
          }
          if (prompt === '/model') {
            output(caps.models);
            first = false;
            continue;
          }
          if (prompt === '/status') {
            output(active);
            first = false;
            continue;
          }
          if (prompt === '/compact') {
            output(
              await client.request('/sessions/' + active.sessionId + '/compact', {
                commandId: id(),
                expectedRevision: active.revision,
              }),
            );
            first = false;
            continue;
          }
          if (prompt === '/clear') {
            await session.open(
              {
                openId: id(),
                workspace: {
                  id: workspace.id,
                  rootHash: contentHash(root),
                  revision: workspace.revision,
                },
                level: 'A',
                mode,
                tools: [],
              },
              { id: credentialKey, profile: name },
            );
            first = false;
            continue;
          }
          if (prompt === '/permissions') {
            output({ mode });
            first = false;
            continue;
          }
          assert(prompt, 'A prompt is required');
          if (f.stdin && first) prompt += '\n\nUntrusted piped input:\n' + (await stdin());
          const context = new ContextProvider(wm, Array.isArray(project.exclude) ? project.exclude : []);
          const attach = first ? ((f.attach as string[]) ?? []) : [];
          if (taskMode && first)
            for (const note of ['AGENTS.md', 'SARION.md'])
              if (wm.files(workspace).includes(note) && permission.contextPaths([note]).length)
                attach.push(note);
          const chunks = await context.collect(workspace, attach, id());
          for (const policy of policies)
            assert(
              chunks.every((c) =>
                policy.uploadPaths.some(
                  (p) =>
                    p === c.path || p === '**' || (p.endsWith('/**') && c.path.startsWith(p.slice(0, -2))),
                ),
              ),
              'Policy forbids selected context upload',
              'POLICY_DENIED',
              4,
            );
          const previous =
            journal.get<{ path: string; ref: P.ContextRef; storedAt?: number }[]>(
              'context:' + active.sessionId,
            ) ?? [];
          const fresh = chunks.filter(
            (c) =>
              !previous.some(
                (p) =>
                  p.path === c.path &&
                  p.ref.sha256 === c.sha256 &&
                  p.ref.revision === c.revision &&
                  (p.storedAt ?? 0) > Date.now() - 86400000,
              ),
          );
          const updated = fresh.length
            ? (
                await client.request<{ refs: P.ContextRef[] }>('/sessions/' + active.sessionId + '/context', {
                  chunks: fresh,
                })
              ).refs
            : [];
          const updatedByPath = new Map(fresh.map((chunk, index) => [chunk.path, updated[index]]));
          const cached = chunks.map((c) => ({
            storedAt: updatedByPath.has(c.path)
              ? Date.now()
              : (previous.find((p) => p.path === c.path)?.storedAt ?? Date.now()),
            path: c.path,
            ref:
              updatedByPath.get(c.path) ??
              previous.find(
                (p) =>
                  p.path === c.path &&
                  p.ref.sha256 === c.sha256 &&
                  p.ref.revision === c.revision &&
                  (p.storedAt ?? 0) > Date.now() - 86400000,
              )!.ref,
          }));
          journal.put('context:' + active.sessionId, cached);
          const refs = cached.map((c) => c.ref);
          const command: P.SubmitCommand = {
            commandId: id(),
            expectedRevision: active.revision,
            kind: taskMode ? 'task' : 'message',
            text: prompt,
            model: String(f.model ?? config.preferences.model),
            ...(f.effort && f.effort !== 'default' ? { effort: String(f.effort) } : {}),
            context: refs,
            memory: [],
            budget: {
              maxSteps: taskMode
                ? Math.min(
                    Number(f['max-steps'] ?? 30),
                    caps.limits.maxSteps,
                    ...policies.map((p) => p.maxSteps),
                  )
                : 1,
              maxWallMs: Math.min(Number(f.timeout ?? 1200) * 1000, ...policies.map((p) => p.maxWallMs)),
              maxCostMicro: f.budget ? Number(f.budget) : null,
              ...(f['max-tool-calls'] ? { maxToolCalls: Number(f['max-tool-calls']) } : {}),
              ...(f['max-output-tokens'] ? { maxOutputTokens: Number(f['max-output-tokens']) } : {}),
              ...(f['max-context-tokens'] ? { maxContextTokens: Number(f['max-context-tokens']) } : {}),
            },
          };
          await session.submit(command);
          rootCommand = command.commandId;
        }
        const ac = new AbortController();
        let interrupted = false;
        const interrupt = () => {
          if (interrupted) process.exit(130);
          interrupted = true;
          ac.abort();
          void session.cancel(rootCommand!).catch(() => {});
        };
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', interrupt);
        try {
          for await (const e of session.consume(ac.signal)) {
          }
        } catch (e) {
          if (interrupted) {
            process.exitCode = 130;
            throw new Failure(
              'INTERRUPTED',
              'Interrupted; use recover ' + session.snapshot!.sessionId,
              130,
              true,
            );
          }
          throw e;
        } finally {
          process.off('SIGINT', interrupt);
          process.off('SIGTERM', interrupt);
        }
        if (format !== 'ndjson') {
          if (format === 'json')
            output({
              sessionId: session.snapshot!.sessionId,
              requestId: rootCommand,
              state: final?.state,
              answer: (final?.result as any)?.answer ?? null,
              usage: final?.usage,
              recoveryRequired: final?.state !== 'committed',
              error: final?.error ?? null,
            });
          else {
            process.stdout.write('\n');
            const answer = (final?.result as any)?.answer;
            renderer.end();
            if (answer && !rendered) output(answer);
            rendered = false;
            renderer = new MarkdownStream({
              style: makeStyle(detectTerm({ flags: { noColor: !!f['no-color'] } })),
              write: (s: string) => process.stdout.write(s),
              columns: process.stdout.columns ?? 80,
            });
          }
        }
        if (final?.state !== 'committed') {
          process.exitCode = final?.state === 'uncertain' ? 5 : 1;
          break;
        }
        if (args.command !== 'chat') break;
        first = false;
      }
    } finally {
      await lock?.release();
      journal.close();
    }
  } finally {
    rl?.close();
  }
}
main().catch((e) => {
  const error =
    e instanceof Failure ? e : new Failure('INTERNAL', e instanceof Error ? e.message : 'Unexpected error');
  const machine =
    process.argv.includes('json') ||
    process.argv.includes('ndjson') ||
    process.argv.some((a) => /^--format=(json|ndjson)$/.test(a));
  if (machine)
    process.stdout.write(
      JSON.stringify({
        state: 'error',
        error: { code: error.code, message: redact(error.message) },
        recoveryRequired: error.uncertain,
      }) + '\n',
    );
  else process.stderr.write(error.code + ': ' + redact(error.message) + '\n');
  process.exitCode = error.exitCode;
});
