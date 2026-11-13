import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// No synthetic service, token, model response, browser cookie or provider key.
// Run only after owner login against the explicitly designated isolated service.
const profile = process.env.SARION_ACCEPTANCE_PROFILE;
const expectedEndpoint = process.env.SARION_ACCEPTANCE_ENDPOINT;
if (!profile || !expectedEndpoint || !process.env.SARION_ACCEPTANCE_BOUNDARY_ID)
  throw Error(
    'Set SARION_ACCEPTANCE_PROFILE, SARION_ACCEPTANCE_ENDPOINT and SARION_ACCEPTANCE_BOUNDARY_ID for an isolated, owner-authorized service after sarion login.',
  );
const entry = path.resolve('bin/sarion.mjs');
const previous = process.env.SARION_ACCEPTANCE_EXISTING_REPORT
  ? JSON.parse(fs.readFileSync(process.env.SARION_ACCEPTANCE_EXISTING_REPORT, 'utf8'))
  : null;
const tmp = previous
  ? path.dirname(previous.fixture)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-live-acceptance-'));
const repo = path.join(tmp, 'repo');
if (!previous) fs.mkdirSync(repo);
const report = {
  evidence: 'REAL SERVICE REQUESTS; no simulated inference',
  endpoint: expectedEndpoint,
  profile,
  startedAt: new Date().toISOString(),
  scenarios: [],
  usage: { inputTokens: 0, outputTokens: 0, cost: null },
  verdict: 'NOT COMPLETE',
  fixture: repo,
};
const run = (args, extra = {}) => {
  const p = spawnSync(
    process.execPath,
    [
      entry,
      ...args,
      '--profile',
      profile,
      '--project',
      repo,
      '--format',
      ...(['ask', 'agent'].includes(args[0])
        ? ['ndjson', '--model', process.env.SARION_ACCEPTANCE_MODEL ?? 'auto']
        : ['json']),
      ...(args[0] === 'agent'
        ? ['--max-steps', '10', '--max-tool-calls', '16', '--max-output-tokens', '2048', '--timeout', '120']
        : []),
    ],
    { env: process.env, encoding: 'utf8', timeout: 150000, ...extra },
  );
  let body;
  try {
    const events = p.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const result = events.findLast((e) => e.t === 'result')?.body;
    body = result
      ? { ...result, answer: result.result?.answer ?? null, streamEvents: events }
      : events.at(-1);
  } catch {
    body = { error: 'Non-JSON response', stdout: p.stdout?.slice(0, 2000) };
  }
  return { status: p.status, body };
};
try {
  const who = run(['whoami']);
  if (
    who.status !== 0 ||
    who.body.url !== expectedEndpoint ||
    who.body.boundary.id !== process.env.SARION_ACCEPTANCE_BOUNDARY_ID
  )
    throw Error('Endpoint/principal validation failed; no inference started');
  report.identity = {
    principal: who.body.principal,
    boundary: who.body.boundary,
    credentialExpiresAt: who.body.credentialExpiresAt,
  };
  if (!previous) {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'src/calc.mjs'), 'export const add=(a,b)=>a-b;\n');
    fs.writeFileSync(
      path.join(repo, 'tests/calc.test.mjs'),
      'import assert from "node:assert/strict"; import {add} from "../src/calc.mjs"; assert.equal(add(2,3),5);\n',
    );
    for (const args of [
      ['init', '-q', repo],
      ['-C', repo, 'add', '.'],
      [
        '-C',
        repo,
        '-c',
        'user.name=Acceptance',
        '-c',
        'user.email=acceptance@example.invalid',
        'commit',
        '-qm',
        'fixture baseline',
      ],
    ]) {
      if (spawnSync('git', args).status !== 0) throw Error('Could not prepare isolated repository');
    }
  }
  const policy = path.join(tmp, 'policy.json');
  fs.writeFileSync(
    policy,
    JSON.stringify({
      schemaVersion: 1,
      boundaryId: who.body.boundary.id,
      workspaceRoot: repo,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      tools: ['fs.read', 'fs.list', 'fs.search', 'patch.apply', 'git.status', 'git.diff', 'process.run'],
      writePaths: ['src/**', 'tests/**'],
      denyPaths: ['.git/**', '.env*'],
      uploadPaths: ['src/**', 'tests/**'],
      commands: [
        {
          file: fs.realpathSync(process.execPath),
          argvPrefix: ['tests/calc.test.mjs'],
          argvTail: [],
          network: 'deny',
        },
      ],
      maxSteps: 10,
      maxWallMs: 120000,
      production: false,
      auditRequired: true,
    }),
    { mode: 0o600 },
  );
  const scenario = (name, args, check) => {
    const old = previous?.scenarios.find((s) => s.name === name && s.passed);
    if (old && check(old.body)) {
      report.scenarios.push({ ...old, reused: true });
      console.log(JSON.stringify({ scenario: name, passed: true, reused: true }));
      return old.body;
    }
    const result = run(args);
    const passed = result.status === 0 && check(result.body);
    report.scenarios.push({ name, passed, ...result });
    console.log(
      JSON.stringify({
        scenario: name,
        passed,
        state: result.body?.state,
        sessionId: result.body?.sessionId,
      }),
    );
    const usage = result.body.usage;
    if (usage) {
      report.usage.inputTokens += usage.inputTokens ?? 0;
      report.usage.outputTokens += usage.outputTokens ?? 0;
    }
    if (!passed)
      throw Error('Acceptance failed: ' + name + '; stop paid diagnostics and inspect the saved report');
    return result.body;
  };
  const nonce =
    previous?.scenarios.find((s) => s.name === 'continuity after process restart')?.body.answer.trim() ??
    randomUUID();
  const memoryMarker = process.env.SARION_ACCEPTANCE_MEMORY_MARKER;
  const first = scenario(
    'genuine streaming conversation',
    [
      'ask',
      'Remember this nonsecret acceptance challenge exactly: ' +
        nonce +
        '. Repeat it once.' +
        (memoryMarker
          ? ' Also recall the nonsecret CLI live acceptance memory marker from my saved memory and print it exactly.'
          : ''),
    ],
    (b) =>
      b.state === 'committed' &&
      b.answer?.includes(nonce) &&
      (!memoryMarker || b.answer?.includes(memoryMarker)),
  );
  scenario(
    'continuity after process restart',
    ['ask', 'Repeat the exact challenge from the previous turn.', '--session', first.sessionId],
    (b) => b.state === 'committed' && b.answer?.includes(nonce),
  );
  scenario(
    'repository inspection',
    [
      'agent',
      'Inspect the repository and identify the calculator defect. Do not modify files.',
      '--share-context',
      '--permission-mode',
      'read-only',
    ],
    (b) =>
      b.state === 'committed' &&
      !!b.answer?.trim() &&
      b.streamEvents?.some((e) => e.t === 'tool_request' && e.request.tool === 'fs.read'),
  );
  scenario(
    'single-file repair and real failing-test diagnosis',
    [
      'agent',
      'Run the current calculator test with ' +
        process.execPath +
        ' tests/calc.test.mjs, diagnose its failure, repair only src/calc.mjs, rerun it and review the diff.',
      '--permission-mode',
      'trusted-automation',
      '--policy',
      policy,
    ],
    (b) =>
      b.state === 'committed' &&
      spawnSync(process.execPath, ['tests/calc.test.mjs'], { cwd: repo }).status === 0,
  );
  scenario(
    'multi-file implementation',
    [
      'agent',
      'Add multiply(a,b) exported from a new src/multiply.mjs; update tests/calc.test.mjs to import it and assert multiply(3,4)===12 alongside the add check. Run the test with ' +
        process.execPath +
        ' tests/calc.test.mjs and review the diff.',
      '--permission-mode',
      'trusted-automation',
      '--policy',
      policy,
    ],
    (b) =>
      b.state === 'committed' &&
      fs.existsSync(path.join(repo, 'src/multiply.mjs')) &&
      spawnSync(process.execPath, ['tests/calc.test.mjs'], { cwd: repo }).status === 0,
  );
  const history = run(['session', 'history', first.sessionId]);
  report.scenarios.push({ name: 'canonical session history', passed: history.status === 0, ...history });
  report.requiredExternalEvidence = [
    'Owner device-login approval/expiry/revocation',
    'Authorized nonsecret memory challenge',
    'Interruption/recovery with durable real-model tool requests',
    'Permission-boundary rejection under genuine model decisions',
    'Authoritative cost settlement',
  ];
  report.verdict = 'PARTIAL REAL-MODEL ACCEPTANCE; inspect receipts and complete external scenarios';
} finally {
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/real-model-acceptance.json', JSON.stringify(report, null, 2) + '\n');
  // Preserve fixture and journal references for receipt/diff review. Never auto-replay.
  console.log(
    JSON.stringify({
      report: path.resolve('artifacts/real-model-acceptance.json'),
      fixture: repo,
      verdict: report.verdict,
    }),
  );
}
