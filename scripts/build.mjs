// Dentiva Pro - build script (main, preload, renderer) via esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'out');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: process.env.DEV ? false : true,
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: [join(root, 'src/main/index.ts')],
  outfile: join(outDir, 'main/index.js'),
  external: ['electron', 'better-sqlite3'],
});

await build({
  ...shared,
  entryPoints: [join(root, 'src/preload/index.ts')],
  outfile: join(outDir, 'preload/index.js'),
  external: ['electron'],
});

await build({
  bundle: true,
  platform: 'browser',
  target: 'chrome126',
  format: 'iife',
  sourcemap: false,
  minify: process.env.DEV ? false : true,
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'warning',
  entryPoints: [join(root, 'src/renderer/src/main.ts')],
  outfile: join(outDir, 'renderer/app.js'),
});

cpSync(join(root, 'src/renderer/styles'), join(outDir, 'renderer/styles'), { recursive: true });
copyFileSync(join(root, 'src/renderer/index.html'), join(outDir, 'renderer/index.html'));

console.log('[build] OK -> out/');
