# SARION CLI v2 preview

Independent TypeScript/Node 24 terminal client for CORTEX Agent Protocol 1.0. The companion SARION adapter must be installed and enabled on an isolated service before remote commands work. This client does not silently use the legacy stateless CLI endpoint. No production activation is included.

## Build and install

Requires Node 24 (security-patched release), npm and Git. Linux/WSL local tools also require Python 3, bubblewrap and util-linux `prlimit`. macOS includes descriptor-relative file tools and a Seatbelt process adapter. Windows includes Win32 protected file tools and DPAPI; arbitrary native Windows processes and Git mutations fail closed (use WSL2). See [qualification](docs/QUALIFICATION.md) for native acceptance gates.

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm install --global --ignore-scripts --prefix "$HOME/.local" .
sarion --version
sarion --help
```

Add the selected prefix's bin directory to PATH. PowerShell: `npm install --global --ignore-scripts --prefix "$env:LOCALAPPDATA\Sarion" .`; use its `sarion.cmd` launcher. No administrator privilege required. `npm run pack:release` creates a tarball/checksum manifest; `SARION_SIGNING_KEY_FILE` adds an Ed25519 signature. Distributable acceptance requires an operator signing key; no private key is committed. `scripts/install.mjs` verifies a signed offline bundle against `SARION_RELEASE_PUBLIC_KEY` before installing. Upgrades are explicit installs of a verified version; no telemetry or automatic update check.

## First connection

```bash
sarion endpoint add staging --url https://your-authorized-service --boundary cloud
sarion endpoint use staging
sarion login
sarion whoami
sarion models
sarion ask 'Explain this architecture' --attach src/main.ts
sarion chat --resume SESSION_ID
sarion agent 'Fix the failing tests' --share-context
```

Linux secure storage uses Secret Service (`secret-tool`); macOS Keychain uses `security`; Windows uses OS DPAPI. If keychain is unavailable, explicitly choose `sarion login --encrypted-store` and provide `SARION_VAULT_PASSPHRASE` from your secret manager or hidden prompt (12+ characters). No plaintext fallback. Headless token input: `sarion login --token --encrypted-store` reads token from stdin and exchanges it for an expiring scoped credential. Never put tokens in command arguments. The encrypted journal data key is protected by the same OS/encrypted broker.

Accounts and tenants are bound to credentials. `account list`/`tenant list` show the currently authorized membership; selecting another tenant requires a separate profile/login. Server membership and entitlements are checked for every request. Cloud sessions and memory remain remote; local SQLite contains encrypted recovery evidence, not an independent memory engine.

## Local workflows

```bash
sarion project init
sarion project files
sarion project search AuthenticationProvider
sarion project read src/main.ts
sarion agent 'Refactor the parser' --permission-mode workspace-write --share-context
sarion agent 'Run the unit checks' --permission-mode trusted-automation --policy /secure/task-policy.json --non-interactive --format json
sarion recover SESSION_ID
sarion recover SESSION_ID --abandon COMMAND_ID
sarion checkpoint list
sarion checkpoint restore CHECKPOINT_ID --permission-mode approval-required
sarion sandbox doctor
sarion audit 20
```

Read-only never executes arbitrary processes. Workspace-write allows checked patches and still asks for processes. Approval-required shows exact effect plans. Trusted automation requires a protected policy outside the repository; denies win. Network/production/privilege escalation, destructive Git and unrestricted shell scripts are unavailable. The local tool set uses typed argv, scoped paths, no-follow filesystem descriptors, Git helper restrictions, network-denied sandbox, process/descriptor/CPU and output/time limits and hash-bound approvals. General processes receive a read-only repository and writable private temporary storage; checked patches own file mutations. Hard aggregate RAM/cgroup containment is not yet qualified.

Project config `.sarion/project.json` accepts only `version` and context `exclude` patterns. `sarion project init --remote-project PROJECT_ID` stores the binding in the private endpoint profile, outside the repository; `--remote-project` can select it explicitly per invocation. Repository content cannot select a remote project, endpoint, credentials or policy. Repeated `--exclude PATTERN` flags further reduce context; `**/` matches root and nested paths. `.gitignore`, sensitive files and symlinks are excluded. Only selected files and authorized tool results reach the endpoint. `AGENTS.md`/`SARION.md` are untrusted project guidance, never permission grants. `ask --stdin` explicitly opts in to piped content. `--format json` gives one final object; `ndjson` emits protocol events. Diagnostics/approvals go to stderr.

Unknown effects are quarantined. Do not delete a journal or reissue a command to bypass recovery. Receipt upload may repeat after ACK loss; execution may not. A process timeout/kill is not proof of rollback. Checkpoint restore is a new checked patch and refuses conflicting user edits. Remote failure, incompatible protocol or sovereign endpoint never triggers cloud/provider fallback. Private zero-egress profiles pin requests to explicitly configured private IPs without DNS or public fallback. Deployment certification additionally requires host/backend firewall and real private-service evidence; see [qualification](docs/QUALIFICATION.md).

## Verification and status

`npm test` uses deterministic protocol fixtures and real native file/process checks. [Distribution](docs/DISTRIBUTION.md) covers SBOM, provenance, signing, upgrades and uninstallation. Real SARION inference requires a provisioned isolated service and owner login; native Linux/macOS/Windows checks passed in [CI](https://github.com/web3devworld/sarion-cli/actions/runs/43404927918) for the documented scope; fixture model responses do not establish live acceptance. See companion SARION `docs/cli-v2/` reports for exact results and release requirements.
