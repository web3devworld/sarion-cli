// Operator-only. No key generation, environment passphrase or registry upload.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseBundle, trustedKey, verifyRelease } from './release-verification.mjs';

const [directory, privateFile, publicFile, fingerprint, sourceCommit, option] = process.argv.slice(2);
if (!sourceCommit || (option && option !== '--passphrase-stdin'))
  throw Error('Usage: node scripts/sign-release.mjs BUNDLE PRIVATE_KEY TRUSTED_PUBLIC_KEY SPKI_SHA256 SOURCE_SHA [--passphrase-stdin]');
const root = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const inside = (file, parent) => file === parent || file.startsWith(parent + path.sep);
const privatePath = fs.realpathSync(privateFile), bundlePath = fs.realpathSync(directory);
const stat = fs.lstatSync(privateFile);
if (!stat.isFile() || stat.isSymbolicLink() || inside(privatePath, root) || inside(privatePath, bundlePath))
  throw Error('Signing key must be a regular file outside the source and bundle');
if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))
  throw Error('Signing key must be owner-only and owned by the signing operator');
if (inside(fs.realpathSync(publicFile), bundlePath)) throw Error('Trust key must be supplied outside the bundle');
const key = trustedKey(publicFile, fingerprint);
const release = releaseBundle(directory);
if (!/^[a-f0-9]{40}$/.test(sourceCommit) || release.provenance.sourceCommit !== sourceCommit)
  throw Error('Release source does not match the reviewed source SHA');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sarion-operator-sign-'));
fs.chmodSync(tmp, 0o700);
try {
  const output = path.join(tmp, 'manifest.sig');
  // OpenSSL prompts at the operator terminal. --passphrase-stdin is solely for
  // a secure password-manager pipe; never put the passphrase in argv or env.
  const signed = spawnSync('openssl', ['pkeyutl', '-sign', '-rawin', '-inkey', privatePath,
    ...(option ? ['-passin', 'stdin'] : []), '-in', path.join(bundlePath, 'manifest.json'), '-out', output],
    { stdio: 'inherit', shell: false });
  if (signed.status !== 0) throw Error('Operator signing failed');
  // Verify before installing the detached signature in the bundle.
  const check = path.join(tmp, 'check');fs.mkdirSync(check);
  for (const name of ['manifest.json', release.manifest.file, ...Object.keys(release.manifest.evidence)])
    fs.copyFileSync(path.join(bundlePath, name), path.join(check, name));
  fs.writeFileSync(path.join(check, 'manifest.sig'), fs.readFileSync(output).toString('base64') + '\n');
  const verified = verifyRelease(check, key);
  if (!verified.bytes.equals(release.bytes) || verified.provenance.sourceCommit !== sourceCommit ||
      !fs.readFileSync(path.join(bundlePath, 'manifest.json')).equals(release.bytes))
    throw Error('Release changed during signing');
  const target = path.join(bundlePath, 'manifest.sig');
  if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw Error('Signature destination must be a regular file');
  // Rename a fresh file instead of following an existing signature symlink.
  const staged = path.join(bundlePath, '.manifest.sig-' + process.pid);
  fs.writeFileSync(staged, fs.readFileSync(path.join(check, 'manifest.sig')), { flag: 'wx', mode: 0o644 });
  fs.renameSync(staged, target);
  console.log('Verified operator signature; trusted SPKI SHA-256: ' + fingerprint);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
