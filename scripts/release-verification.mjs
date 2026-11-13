import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const read = (directory, name) => {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Release files must be regular files');
  return fs.readFileSync(file);
};
export function releaseBundle(directory, bytes = read(directory, 'manifest.json')) {
  const manifest = JSON.parse(bytes);
  if (manifest.protocol !== '1.0' || typeof manifest.version !== 'string' ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || !digest.test(manifest.sha256) ||
      typeof manifest.file !== 'string' || path.basename(manifest.file) !== manifest.file ||
      !/^volta-sarion-cli-[0-9A-Za-z.+-]+\.tgz$/.test(manifest.file)) throw Error('Invalid release manifest');
  const payload = read(directory, manifest.file);
  if (payload.length !== manifest.bytes || sha256(payload) !== manifest.sha256) throw Error('Package checksum mismatch');
  const evidence = manifest.evidence;
  if (!evidence || !digest.test(evidence['sbom.cdx.json']) || !digest.test(evidence['build-provenance.json']))
    throw Error('Required release evidence missing');
  for (const [name, hash] of Object.entries(evidence)) {
    if (path.basename(name) !== name || !digest.test(hash) || sha256(read(directory, name)) !== hash)
      throw Error('Release evidence checksum mismatch');
  }
  const provenance = JSON.parse(read(directory, 'build-provenance.json'));
  const sbom = JSON.parse(read(directory, 'sbom.cdx.json'));
  if (!/^[a-f0-9]{40}$/.test(provenance.sourceCommit) || !digest.test(provenance.lockSha256) ||
      sbom.bomFormat !== 'CycloneDX' || sbom.metadata?.component?.version !== manifest.version)
    throw Error('Release provenance/SBOM invalid');
  return { bytes, manifest, provenance };
}

export function trustedKey(file, fingerprint) {
  const key = createPublicKey(fs.readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw Error('An Ed25519 trusted public key is required');
  const actual = sha256(key.export({ type: 'spki', format: 'der' }));
  if (!digest.test(fingerprint) || actual !== fingerprint) throw Error('Trusted public-key fingerprint mismatch');
  return key;
}

export function verifyRelease(directory, key) {
  const raw = read(directory, 'manifest.json');
  const encoded = read(directory, 'manifest.sig').toString('utf8').trim();
  const signature = Buffer.from(encoded, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== encoded || !verify(null, raw, key, signature))
    throw Error('Invalid Ed25519 release signature');
  return releaseBundle(directory, raw);
}
