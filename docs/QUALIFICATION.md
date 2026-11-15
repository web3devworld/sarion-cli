# Candidate qualification

Candidate 2.0.0-preview.2 uses CORTEX Agent Protocol 1.0. The companion SARION
`docs/cli-v2/SARION_CLI_V2_FINAL_READINESS.md` is the consolidated acceptance record.
Do not interpret a package build or protocol simulator as real inference. Native CI [run 43412788461](https://github.com/web3devworld/sarion-cli/actions/runs/43412788461) passed on Linux, macOS 15 Intel and Windows 2022 at implementation commit `93e0c65df9065360d987aedf945eaf1bd4f7c692`. This includes Keychain/DPAPI, journal recovery and signed offline installation using fixture keys; Linux Secret Service needs a separately provisioned user session.

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


Genuine Preview.2 cloud acceptance passed on 2026-11-13 in a dedicated SARION
Worker/D1 with real device credentials and Cloudflare gpt-oss-120b inference.
Streaming, memory, restart continuity, failing-test repair, coordinated two-file
coding, same-session correction, exact policy denial and durable recovery passed.
The companion backend final-readiness and real-model reports retain failed
attempts and repairs; staging was then retired and device credentials revoked.
No production activation or package publication occurred. This is a small real
coding acceptance fixture, not a general competence or adversarial benchmark.

The historical 2026-11-13 unsigned package SHA-256 was
`fe9fa5c1b5cf9740193567a6230c55ce59ffa97df261573aca7e0be2478023dd`
(831,078 bytes), built from implementation 93e0c65. Its SBOM/provenance and exact
manifest are recorded with the companion live evidence. Operator signing remains
required for controlled distribution. Enterprise infrastructure and Linux Secret
Service session qualification remain as described above.


Production acceptance subsequently completed five genuine operations on Worker
`9a934c63-49ab-465e-8e2f-de9962dd43f5`, source
`b20b5c3a296aef2da5ad6e5ca735e203f78992f9`; SARION documentation PR #425
records the redacted closure and private authoritative receipt references.
That campaign used reviewed client `5b5a719672d6923a1f0e63a3e8e4238927ae85a2`.
The distribution successor changes documentation and omits debug source maps
from the package; runtime/authentication/protocol sources remain identical.
Its exact package checksum is in its accompanying `manifest.json` and
`SHA256SUMS`, superseding the historical package bytes above for distribution.
Signing and owner-authorized delivery remain required; package preparation is
not publication. No additional paid acceptance operation is required or authorized.
