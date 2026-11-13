import type * as P from '../agent-protocol/contracts.ts';
import { validate } from '../agent-protocol/schema.ts';
import { Failure, assert } from '../agent-protocol/validation.ts';
import { endpointFetch } from '../platform/network.ts';
import type { Profile } from '../platform/config.ts';
export async function jsonBounded(response: Response, max = 2097152): Promise<any> {
  assert(response.body, 'Missing JSON response');
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        text += decoder.decode();
        break;
      }
      bytes += r.value.length;
      assert(bytes <= max, 'JSON response exceeds limit', 'INVALID_REQUEST', 7);
      text += decoder.decode(r.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(text);
}
export async function* ndjson(body: ReadableStream<Uint8Array>, max = 128 * 1024): AsyncGenerator<unknown> {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    for (;;) {
      const r = await reader.read();
      buffer += decoder.decode(r.value, { stream: !r.done });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        assert(Buffer.byteLength(line) <= max, 'Event too large');
        if (line.trim()) yield JSON.parse(line);
      }
      assert(Buffer.byteLength(buffer) <= max, 'Event too large');
      if (r.done) {
        assert(!buffer.trim(), 'Incomplete NDJSON frame', 'STREAM_INTERRUPTED', 5);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class CortexClient implements P.CortexClient {
  private caps?: P.Capabilities;
  constructor(
    public profile: Profile,
    private token: () => string,
    private transport: typeof fetch = fetch,
  ) {}
  async request<T>(
    route: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    signal?: AbortSignal,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.raw(route, body, method, signal, extra);
    return (await jsonBounded(response)) as T;
  }
  async raw(
    route: string,
    body?: unknown,
    method = 'GET',
    signal?: AbortSignal,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    assert(route.startsWith('/') && !route.includes('..'), 'Invalid API path');
    const r = await endpointFetch(
      this.profile,
      this.profile.url + '/api/agent/v1' + route,
      {
        method,
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(60000),
        headers: {
          Authorization: 'Bearer ' + this.token(),
          'Cortex-Agent-Version': '1.0',
          'X-Sarion-Cli-Version': '2.0.0-preview.2',
          'Content-Type': 'application/json',
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.transport,
    );
    if (!r.ok) {
      const b = (await jsonBounded(r, 65536).catch(() => ({}))) as any;
      const e = b.error ?? {};
      throw new Failure(
        typeof e === 'string' ? e : (e.code ?? 'HTTP_' + r.status),
        e.message ?? b.message ?? 'Request failed (' + r.status + ')',
        r.status === 401
          ? 3
          : r.status === 429
            ? 6
            : r.status === 409
              ? 5
              : r.status === 426 || r.status === 404
                ? 7
                : 1,
        r.status === 409,
      );
    }
    return r;
  }
  async capabilities(signal: AbortSignal): Promise<P.Capabilities> {
    const c = validate<P.Capabilities>(
      'Capabilities',
      await this.request('/capabilities', undefined, 'GET', signal),
    );
    assert(
      c.protocol === '1.0' && c.features.durableTurns,
      'Unsupported agent protocol',
      'PROTOCOL_UNSUPPORTED',
      7,
    );
    assert(c.boundary.kind === this.profile.boundary, 'Deployment boundary mismatch', 'TENANT_MISMATCH', 3);
    for (const k of ['boundaryId', 'issuer', 'audience'] as const) {
      const actual = k === 'boundaryId' ? c.boundary.id : c.boundary[k];
      assert(
        !this.profile[k] || this.profile[k] === actual,
        'Deployment identity changed',
        'TENANT_MISMATCH',
        3,
      );
    }
    if (this.profile.principal)
      assert(
        JSON.stringify(this.profile.principal) ===
          JSON.stringify({
            subject: c.principal.subject,
            tenantId: c.principal.tenantId,
            accountId: c.principal.accountId,
          }),
        'Principal changed; select/login a new profile',
        'TENANT_MISMATCH',
        3,
      );
    this.caps = c;
    return c;
  }
  async open(input: P.OpenSession): Promise<P.SessionSnapshot> {
    return validate('SessionSnapshot', await this.request('/sessions', input));
  }
  async snapshot(id: string): Promise<P.SessionSnapshot> {
    return validate('SessionSnapshot', await this.request('/sessions/' + encodeURIComponent(id)));
  }
  async submit(session: string, command: P.SubmitCommand): Promise<P.Accepted> {
    return this.request('/sessions/' + session + '/commands', command);
  }
  async status(session: string, command: string): Promise<P.CommandSnapshot> {
    return validate('CommandSnapshot', await this.request('/sessions/' + session + '/commands/' + command));
  }
  async *events(session: string, after: number, signal: AbortSignal): AsyncIterable<P.AgentEvent> {
    const r = await this.raw('/sessions/' + session + '/events?after=' + after, undefined, 'GET', signal);
    assert(r.headers.get('content-type')?.includes('application/x-ndjson') && r.body, 'Expected NDJSON');
    for await (const e of ndjson(r.body, this.caps?.limits.eventBytes))
      yield validate<P.AgentEvent>('AgentEvent', e);
  }
  claim(s: string, c: string, input: P.ClaimRequest): Promise<P.ClaimResponse> {
    return this.request(`/sessions/${s}/tools/${c}/claim`, input);
  }
  receipt(r: P.ExecutionReceipt, token?: string): Promise<P.ReceiptAck> {
    return this.request(
      `/sessions/${r.sessionId}/tools/${r.commandId}/receipts`,
      r,
      'POST',
      undefined,
      token ? { 'Cortex-Execution-Token': token } : {},
    );
  }
  async approve(s: string, d: P.ApprovalDecision): Promise<void> {
    await this.request(`/sessions/${s}/approvals/${d.id}`, d);
  }
  cancel(s: string, input: P.CancelRequest): Promise<P.CommandSnapshot> {
    return this.request(`/sessions/${s}/cancel`, input);
  }
  resolve(s: string, input: P.Resolution): Promise<P.CommandSnapshot> {
    return this.request(`/sessions/${s}/resolve`, input);
  }
}
export class ModelCapabilityProvider implements P.ModelCapabilityProvider {
  private cache?: P.Capabilities;
  constructor(private client: CortexClient) {}
  async list(): Promise<P.ModelCapability[]> {
    this.cache = await this.client.capabilities(AbortSignal.timeout(15000));
    return this.cache.models;
  }
  async select(p: string, r: { tools: boolean; minContext: number }): Promise<P.ModelCapability> {
    const models = await this.list();
    const m = models.find((m) => m.id === (p === 'auto' ? this.cache!.defaultModel : p));
    assert(
      m?.eligible &&
        (!r.tools || m.tools) &&
        (!r.minContext || (m.contextTokens !== null && m.contextTokens >= r.minContext)),
      'Model capability unavailable',
      'CAPABILITY_MISSING',
      7,
    );
    return m;
  }
  invalidate(): void {
    this.cache = undefined;
  }
}
