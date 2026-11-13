# Distribution and signing

Use Node 24.21.0, the committed npm lockfile and Python 3/Git for local tools.
Install Linux bubblewrap and util-linux; macOS uses system sandbox-exec. Native
Windows file tools require Python 3.12/3.13 in its documented user installation
or `SARION_PYTHON`. Windows processes require WSL2.

```
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run pack:release
node scripts/verify-artifact.mjs
npm audit --json > artifacts/dependency-audit.json
```

`artifacts/` contains the dependency-free universal Node package, SHA-256 manifest,
CycloneDX SBOM and source/lock/build provenance. The manifest records Linux,
macOS and Windows targets and hashes the SBOM/provenance. Build twice with the
same source/toolchain and compare package SHA-256. Unsigned provenance is evidence,
not an authenticated SLSA attestation. Native qualification is separate from
reproducibility. No public registry publication is part of this workflow.

Operator signing (Ed25519, key supplied outside the repository):

```
SARION_SIGNING_KEY_FILE=/secure/operator.pem npm run pack:release
SARION_RELEASE_PUBLIC_KEY=/trusted/operator-public.pem node scripts/install.mjs /offline/bundle /user/prefix
```

Distribute manifest, signature, package, SBOM, provenance and reviewed installer.
Deliver the trusted public key out of band. The installer verifies signature,
package checksum and evidence hashes before an offline installation with scripts,
audit and funding network access disabled. Fixture test keys are never release
keys. Platform-native binary signing/notarization is inapplicable to a Node JS
package; any future native helper/executable needs its own signing gate.

For development source installation: `npm install --global --ignore-scripts
--prefix "$HOME/.local" .`. macOS uses the same user-prefix installation. On
Windows use `npm install --global --ignore-scripts --prefix
"$env:LOCALAPPDATA\Sarion" .` and its `sarion.cmd` launcher. Add the installation
bin directory to PATH. Normal login uses the same device approval as SARION,
without copying browser cookies or manually editing credential files.

Upgrade by explicitly installing a verified new bundle after stopping sessions.
Rollback by reinstalling the previously verified bundle; preserve journals,
checkpoints, credentials and pending receipts. Never downgrade through an
unsupported journal schema or delete state to unblock execution.

Uninstall using `npm uninstall --global --ignore-scripts --offline --no-audit
--no-fund --prefix PREFIX @volta/sarion-cli`. First revoke with `sarion logout`;
if offline, `logout --local-only` reports remote revocation pending. Uninstalling
does not erase recovery state or revoke remote credentials. Retain unresolved
journals until effects are reconciled and credentials revoked through the owner.
