# Candidate qualification

Candidate 2.0.0-preview.2 uses CORTEX Agent Protocol 1.0. The companion SARION
`docs/cli-v2/SARION_CLI_V2_FINAL_READINESS.md` is the consolidated acceptance record.
Do not interpret a package build or protocol simulator as real inference.

| Runtime | Implemented scope | Native evidence required |
|---|---|---|
| Linux | Protected files/patches, Git, network-denied bubblewrap processes | File, process, network, recovery and credential tests |
| macOS | Descriptor-relative Python files, Keychain, Seatbelt processes | Native helper, sandbox and Keychain qualification |
| Windows | Win32 no-reparse/ancestor-lock file helper, DPAPI, Git reads | Native file, ACL, DPAPI and installation qualification |
| Windows process/Git mutation | Refused; use WSL2 | Audited AppContainer/Job Object helper before enabling |

`.github/workflows/qualify.yml` runs native checks on Linux, macOS and Windows.
A failed native security probe is a release gate; it must not be skipped to turn
CI green. `SARION_PYTHON` and `SARION_GIT` can select absolute, installed helpers
outside the workspace (use this with managed Python installations).

For private endpoints:

```
sarion endpoint add enterprise --url https://cortex.internal --boundary sovereign --zero-egress --addresses 10.40.0.8
sarion endpoint use enterprise
sarion login --enterprise --encrypted-store
sarion endpoint doctor --offline
sarion agent 'Inspect the parser' --offline --share-context --permission-mode read-only --max-steps 8 --max-tool-calls 12
```

Provision internal TLS trust via the OS/Node trust store before startup. Never
turn off certificate verification. `--enterprise` reads a provisioned assertion
from stdin or hidden prompt and exchanges it only at the selected private
`POST /api/agent/v1/auth/enterprise`. The enterprise service must validate issuer,
audience, tenant, scopes and expiration and return `access_token` and
`expires_at` (UTC epoch milliseconds). It must implement the same capability
protocol. The cloud SARION adapter does not pretend to be an enterprise IdP.
Device login remains available if the private endpoint implements it.

Zero-egress profile requests use pinned private IPs with no DNS, proxies,
redirects or cloud fallback. This is an application request boundary. Host and
backend firewalls, private identity/inference/memory and packet-capture evidence
are deployment requirements for an air-gap or zero-egress certification. Offline
means public Internet is unnecessary when all required private services and
trust material are provisioned; it does not mean local inference was added.
`node scripts/sovereign-simulator.mjs` supplies only private discovery and failure
responses; it has no model, identity provider or memory store.

For headless credentials, bind environment injection explicitly:
`SARION_TOKEN_PROFILE=profile@https://exact-endpoint` alongside `SARION_TOKEN`.
A token for another profile is refused. Credential expiry is shown by `whoami`;
reauthorize with `login`. No unsupported refresh-token flow is invented.

Agent calls and tools execute serially. Limits: 30 model steps, 128 total tool
calls (including server plan/recall), 1,200 seconds, 4,096 output tokens per model
step, and a 20,000 estimated-token context ceiling. Flags can reduce these bounds;
managed policy further restricts step/time limits. Monetary ceilings are refused
because authoritative monetary settlement is unavailable. A timeout or signal
is an uncertain result, never proof that effects were rolled back.
