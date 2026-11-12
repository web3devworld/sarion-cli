import type * as P from '../agent-protocol/contracts.ts';
import { CortexClient, jsonBounded } from '../cortex-client/index.ts';
import { CredentialStore } from './credentials.ts';
import type { Profile } from './config.ts';
import { assert, Failure } from '../agent-protocol/validation.ts';
export const scopes = [
  'agent.session.read',
  'agent.session.write',
  'agent.context.write',
  'agent.memory.read',
  'agent.tools.coordinate',
  'agent.usage.read',
];
export class AuthenticationProvider implements P.AuthenticationProvider {
  private active = '';
  constructor(
    private selected: Profile,
    private store: CredentialStore,
    private readToken: () => Promise<string>,
    private display: (s: string) => void,
  ) {}
  private async bootstrap(path: string, value: unknown): Promise<any> {
    const r = await fetch(this.selected.url + path, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'Cortex-Agent-Version': '1.0',
        'X-Sarion-Cli-Version': '2.0.0-preview.1',
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(20000),
    });
    const b = (await jsonBounded(r, 65536)) as any;
    if (!r.ok && b.error !== 'authorization_pending' && b.error !== 'slow_down')
      throw new Failure(
        'AUTHENTICATION_FAILED',
        typeof b.error === 'string' ? b.error : 'Device authentication failed',
        3,
      );
    return b;
  }
  async login(profile: string, method: 'device' | 'token' | 'enterprise'): Promise<P.CredentialHandle> {
    assert(
      method !== 'enterprise',
      'Enterprise auth adapter must be provisioned for this endpoint',
      'CAPABILITY_MISSING',
      7,
    );
    if (method === 'token') {
      this.active = (await this.readToken()).trim();
      assert(/^sar_cli_[a-f0-9]{64}$/.test(this.active), 'Invalid token format', 'UNAUTHENTICATED', 3);
      const c = new CortexClient(this.selected, () => this.active);
      const issued = await c.request<any>('/auth/authorize', { scopes });
      this.active = issued.access_token;
    } else {
      const start = await this.bootstrap('/api/cli/device/start', {
        label: 'SARION v2: conversations, project context, locally approved tools',
      });
      assert(
        typeof start.device_code === 'string' &&
          typeof start.user_code === 'string' &&
          new URL(start.verification_uri).origin === new URL(this.selected.url).origin,
        'Invalid device response',
        'UNAUTHENTICATED',
        3,
      );
      this.display('Approve code ' + start.user_code + ' at ' + start.verification_uri);
      let interval = Math.max(5, Number(start.interval) || 5) * 1000;
      const expires = Date.now() + Math.min(Number(start.expires_in) || 600, 600) * 1000;
      while (Date.now() < expires) {
        await new Promise((r) => setTimeout(r, interval));
        const polled = await this.bootstrap('/api/cli/device/poll', { device_code: start.device_code });
        if (polled.access_token) {
          this.active = polled.access_token;
          break;
        }
        if (polled.error === 'slow_down') interval += 5000;
      }
      assert(this.active, 'Device code expired', 'UNAUTHENTICATED', 3);
    }
    const client = new CortexClient(this.selected, () => this.active);
    const caps = await client.capabilities(AbortSignal.timeout(20000));
    this.store.put(profile, this.active);
    return { id: profile, profile };
  }
  async principal(handle: P.CredentialHandle): Promise<P.Principal> {
    return (
      await new CortexClient(this.selected, () => this.store.token(handle.profile)).capabilities(
        AbortSignal.timeout(20000),
      )
    ).principal;
  }
  async revoke(handle: P.CredentialHandle): Promise<{ remoteRevoked: boolean; pending: boolean }> {
    let remote = false;
    try {
      await new CortexClient(this.selected, () => this.store.token(handle.profile)).request('/auth/revoke', {});
      remote = true;
    } finally {
      this.store.remove(handle.profile);
    }
    return { remoteRevoked: remote, pending: !remote };
  }
}
