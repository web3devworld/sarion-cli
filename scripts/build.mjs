import { build } from 'esbuild';
import fs from 'node:fs';
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });
await build({
  entryPoints: {
    sarion: 'apps/cli/src/main.ts',
    runtime: 'packages/local-runtime/tools.ts',
    client: 'packages/cortex-client/index.ts',
    journal: 'packages/local-runtime/journal.ts',
    permissions: 'packages/local-runtime/permissions.ts',
    workspace: 'packages/local-runtime/workspace.ts',
    args: 'apps/cli/src/args.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  banner: {
    js: "import {createRequire as __sarionCreateRequire} from 'node:module';const require=__sarionCreateRequire(import.meta.url);",
  },
  sourcemap: true,
});
fs.copyFileSync('packages/platform/fs-helper.py', 'dist/fs-helper.py');

fs.copyFileSync('packages/platform/fs-windows.py', 'dist/fs-windows.py');
