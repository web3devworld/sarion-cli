import test from 'node:test';
import assert from 'node:assert/strict';
import { ndjson, CortexClient } from '../packages/cortex-client/index.ts';
import { parse } from '../apps/cli/src/args.ts';
import { hash } from '../packages/agent-protocol/validation.ts';
test('bounded parser, compatibility aliases and no implicit --yes', () => {
  assert.equal(parse([]).command, 'chat');
  assert.equal(parse(['ask', 'explain', '--attach', 'src/a.ts', '--format', 'json']).flags.format, 'json');
  assert.equal(
    parse(['agent', 'task', '--permission-mode', 'workspace-write']).flags['permission-mode'],
    'workspace-write',
  );
  assert.throws(() => parse(['agent', 'task', '--yes']), /removed/);
  assert.throws(() => parse(['--unknown']), /Unknown/);
  assert.throws(() => parse(['--profile']), /Missing/);
  assert.throws(() => parse(['usage', '--model', 'auto']), /not valid/);
  assert.throws(() => hash({ bad: undefined }), /Non-JSON/);
});
test('NDJSON handles byte-split UTF-8/CRLF and rejects truncated/oversize', async () => {
  const bytes = new TextEncoder().encode('{"text":"é😀"}\r\n');
  const body = new ReadableStream({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b]));
      c.close();
    },
  });
  const result = [];
  for await (const o of ndjson(body)) result.push(o);
  assert.deepEqual(result, [{ text: 'é😀' }]);
  for (const text of ['{"x":1}', 'x'.repeat(100)]) {
    const b = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    await assert.rejects(async () => {
      for await (const o of ndjson(b, 20)) {
      }
    });
  }
});
test('client sends pinned bearer and never retries writes or follows redirects', async () => {
  let calls = 0;
  const profile = { url: 'https://fixture.test', boundary: 'cloud' };
  const client = new CortexClient(
    profile,
    () => 'fixture-token',
    async (url, init) => {
      calls++;
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer fixture-token');
      return new Response(JSON.stringify({ error: { code: 'EXECUTION_UNCERTAIN', message: 'read status' } }), {
        status: 409,
      });
    },
  );
  await assert.rejects(client.request('/sessions', { test: true }), /read status/);
  assert.equal(calls, 1);
  await assert.rejects(client.request('/../elsewhere'), /Invalid API/);
});
test('exclusions are explicit repeated flags and recursive globs match root and nested files', async () => {
  const { matches, clean } = await import('../packages/agent-protocol/validation.ts');
  assert.deepEqual(parse(['agent', 'task', '--exclude', '**/*.secret', '--exclude', 'private/**']).flags.exclude, [
    '**/*.secret',
    'private/**',
  ]);
  assert.equal(matches('**/*.secret', 'a.secret'), true);
  assert.equal(matches('**/*.secret', 'src/a.secret'), true);
  assert.equal(matches('private/**', 'private/a.txt'), true);
  assert.equal(matches('tests/*.mjs', 'tests/a/b.mjs'), false);
  assert.equal(clean('\u009dclipboard\u009c'), 'clipboard');
});
