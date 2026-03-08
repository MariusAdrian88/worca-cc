#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function run() {
  const thisFile = fileURLToPath(new URL(import.meta.url));
  const repoRoot = path.resolve(path.dirname(thisFile), '..');
  const appDir = path.join(repoRoot, 'app');
  const entry = path.join(appDir, 'main.js');
  const outfile = path.join(appDir, 'main.bundle.js');

  mkdirSync(appDir, { recursive: true });

  try {
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      outfile,
      sourcemap: true,
      minify: true,
      legalComments: 'none'
    });
    console.log('built', path.relative(repoRoot, outfile));
  } catch (err) {
    console.error('bundle error', err);
    process.exitCode = 1;
  }
}

run();
