import path from 'node:path';
import fs from 'node:fs';
import { trustedKey, verifyRelease } from './release-verification.mjs';
const [directory, publicFile, fingerprint] = process.argv.slice(2);
if (!fingerprint) throw Error('Usage: node scripts/verify-release.mjs BUNDLE TRUSTED_PUBLIC_KEY SPKI_SHA256');
const bundle = fs.realpathSync(directory), trusted = fs.realpathSync(publicFile);
if (trusted === bundle || trusted.startsWith(bundle + path.sep)) throw Error('Trust key must be supplied outside the bundle');
const result = verifyRelease(directory, trustedKey(publicFile, fingerprint));
console.log(JSON.stringify({ verified: true, algorithm: 'Ed25519', version: result.manifest.version,
  sourceCommit: result.provenance.sourceCommit, packageSha256: result.manifest.sha256 }));
