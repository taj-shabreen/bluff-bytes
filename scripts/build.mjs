import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const files = ['index.html', 'app.js', 'style.css'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of files) await cp(file, `dist/${file}`);
await mkdir('.netlify/function-check', { recursive: true });
await build({
  entryPoints: ['netlify/functions/game.ts'],
  bundle: true,
  packages: 'bundle',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: '.netlify/function-check/game.mjs',
  logLevel: 'warning',
});
await build({
  entryPoints: ['scripts/test-game.ts'],
  bundle: true,
  packages: 'bundle',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: '.netlify/function-check/test-game.mjs',
  logLevel: 'warning',
});
console.log(`Prepared ${files.length} browser files and compiled the Netlify Function bundle.`);
