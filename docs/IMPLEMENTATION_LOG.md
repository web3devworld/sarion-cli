# Implementation campaign

Architecture 90268a2; Milestones 1–4. No production actions or paid inference authorized.

Single backlog: protocol/client; auth/config/journal; workspace/context; permissions/patch/process/Git; backend adapter/scopes/tenant/holds; session controller/CLI; deterministic acceptance; release documentation. Full validation runs once after integration.

Implemented protocol/client, encrypted credential broker, SQLite journal, Linux descriptor helper, permission/grant engine, patch manifests, sandbox supervisor, Git adapter, tool registry, session dispatcher and command interface. Backend adapter lives in sibling SARION worktree; no Worker imports in CLI. During integration, changed Windows credential transport to OS DPAPI instead of an unshipped native Credential Manager helper; native platform qualification remains unverified. Local network/production/destructive Git execution deliberately unavailable, even with a grant.

Reused original 0.6.1 terminal Markdown/style/highlighter/diff modules and vendored BSD code unchanged. Rooted file helpers exclude ignored/sensitive paths; unattended read results intersect uploadPaths. Context refs are cached per remote session to transmit only changed chunks. General processes get a read-only workspace plus private writable /tmp; file mutation is via checked patch tools. Explicit typed Git mutations receive only their repository metadata mount. No network grant can widen the preview's deny boundary.

Consolidated validation completed on Ubuntu 26.04.1 / Node 24.21.0: client typecheck; 19 deterministic client/runtime/recovery tests; backend typecheck and targeted adapter/security/regression groups; actual built CLI through the real adapter and metered gateway using scripted provider frames, editing two files and running failing/corrected passing Node tests. All final affected checks pass. Offline package install/start/help and signature rejection passed with an ephemeral fixture key. Linux/macOS/Windows conditional bundles compile; native macOS/Windows execution is NOT RUN.

Defects fixed during the single campaign: fixture schema parity; route scanner support without weakening guard checks; gateway streaming for the CLI surface; crash/ACK claim quarantine; Git helper and clean-filter isolation; workspace mutation recovery barrier; private remote-project bindings; context references keyed by path as well as hash; batched bounded local search; active-task privacy/deletion fences; local/remote retention and account erasure cascades. All backend source remains default-off and migration held.

Release blockers: deployed nonproduction adapter/scoped credentials and authorized live inference budget; real account/tenant/revocation acceptance; native OS credential and runtime qualification; signing identity and controlled release review. No deployment, production migration, secrets change, package publication or successful paid inference occurred. See companion five implementation reports for evidence and exact limitations.


## Final live acceptance — 2026-11-13

Real SARION device login, encrypted persistence, memory/streaming/restart continuity,
repository inspection, failing-test diagnosis/repair, coordinated two-file coding,
follow-up correction and durable policy-denial/recovery passed against an isolated
Worker/D1. Repairs preserve assistant tool-call frames, normalize root listings,
quarantine blank finals, bound schema correction, durably report known denials,
clarify process arguments and include protected untracked source in diffs. The
backend also prevents scoped tokens bypassing authorization through legacy routes.
The companion backend reports contain sanitized transcripts, IDs, receipts and
fixture diffs. Actual provider usage: 52 successful calls, 70,565 input / 6,701 output
tokens, USD 0.029725 SARION trace-priced cost. No production credentials or resources
were used. Native CI 43412788461 passed all three OS jobs at implementation 93e0c65.
The staging ingress/provider binding is retired, device tokens revoked, and private
credential/evidence retention encrypted. Release signing/activation remain separate.
