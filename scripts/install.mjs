import fs from 'node:fs';
import path from 'node:path';
import { createHash, verify, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [directory, prefix] = process.argv.slice(2);
if (!directory || !prefix || !process.env.SARION_RELEASE_PUBLIC_KEY)
  throw Error('Usage: SARION_RELEASE_PUBLIC_KEY=/trusted/key.pem node scripts/install.mjs /bundle /user/prefix');
const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json'));
if (
  !verify(
    null,
    manifestBytes,
    createPublicKey(fs.readFileSync(process.env.SARION_RELEASE_PUBLIC_KEY)),
    Buffer.from(fs.readFileSync(path.join(directory, 'manifest.sig'), 'utf8'), 'base64'),
  )
)
  throw Error('Invalid release signature');
const manifest = JSON.parse(manifestBytes);
if (path.basename(manifest.file) !== manifest.file) throw Error('Invalid artifact path');
const file = path.join(directory, manifest.file),
  data = fs.readFileSync(file);
if (data.length !== manifest.bytes || createHash('sha256').update(data).digest('hex') !== manifest.sha256)
  throw Error('Artifact checksum mismatch');
const windowsNpm =
  process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (process.platform === 'win32' && !fs.existsSync(windowsNpm)) throw Error('Cannot find the provisioned npm CLI');
execFileSync(
  process.platform === 'win32' ? process.execPath : 'npm',
  [
    ...(process.platform === 'win32' ? [windowsNpm] : []),
    'install',
    '--global',
    '--offline',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--prefix',
    path.resolve(prefix),
    path.resolve(file),
  ],
  { stdio: 'inherit', shell: false },
);
