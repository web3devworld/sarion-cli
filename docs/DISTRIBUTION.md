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

`artifacts/` contains the dependency-free universal Node package, SHA-256 manifest (excluding debug source maps from the package),
CycloneDX SBOM and source/lock/build provenance. The manifest records Linux,
macOS and Windows targets and hashes the SBOM/provenance. Build twice with the
same source/toolchain and compare package SHA-256. Unsigned provenance is evidence,
not an authenticated SLSA attestation. Native qualification is separate from
reproducibility. No public registry publication is part of this workflow.

Operator signing uses the separately reviewed [operator procedure](OPERATOR_SIGNING.md).
Packaging always produces an unsigned candidate. The old SARION_SIGNING_KEY_FILE
packaging shortcut is refused; keys and passphrases do not enter the build.
After source/hash review, sign with the owner-controlled Ed25519 key:

```
node scripts/sign-release.mjs /offline/bundle /secure/operator.pem /trusted/operator-public.pem SPKI_SHA256 REVIEWED_SOURCE_SHA
node scripts/verify-release.mjs /offline/bundle /trusted/operator-public.pem SPKI_SHA256
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


## Production closure and publication boundary — 2026-11-15

Backend acceptance is complete; see SARION documentation PR #425. Client runtime
and protocol contracts remain those of reviewed client `5b5a719672d6923a1f0e63a3e8e4238927ae85a2`.
The distribution successor changes packaging/documentation only, retaining version
`2.0.0-preview.2`. Reuse the existing 157-test backend evidence, native client
qualification and five-operation genuine production acceptance. Do not repeat
paid operations to prepare this bundle.

The approved channel remains owner-signed offline distribution. `private: true`
and `UNLICENSED` are intentional. No npm publishing authorization or GitHub
Release delivery authorization is established by package preparation. Do not
remove `private`, push release tags or publish assets automatically. Owner must
designate the existing signing key, confirm its fingerprint, approve the exact
reviewed source/hash and audience, then deliver the signed bundle through the
approved internal channel. No new signing identity is needed by this workflow.
