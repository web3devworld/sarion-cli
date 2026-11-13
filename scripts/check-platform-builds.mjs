import { build } from 'esbuild';
import { createHash } from 'node:crypto';
for (const platform of ['linux', 'darwin', 'win32']) {
  const result = await build({
    entryPoints: ['apps/cli/src/main.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    define: { 'process.platform': JSON.stringify(platform) },
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
  });
  console.log(
    JSON.stringify({
      platform,
      bytes: result.outputFiles[0].contents.length,
      sha256: createHash('sha256').update(result.outputFiles[0].contents).digest('hex'),
      evidence: 'bundle generation only; native runtime not established',
    }),
  );
}
