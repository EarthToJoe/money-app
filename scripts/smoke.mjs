#!/usr/bin/env node
// Finch smoke test: the gate is (1) `tsc --noEmit` clean and (2) `vite build` succeeds.
// No TS is imported directly (no ts-node). Run with: node scripts/smoke.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'build', cmd: 'npx', args: ['vite', 'build'] },
];

for (const step of steps) {
  console.log(`\n== ${step.name}: ${step.cmd} ${step.args.join(' ')}`);
  const r = spawnSync(step.cmd, step.args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\nSMOKE FAIL: ${step.name} exited with ${r.status}`);
    process.exit(1);
  }
}

const index = path.join(root, 'dist', 'index.html');
if (!existsSync(index) || statSync(index).size === 0) {
  console.error('\nSMOKE FAIL: dist/index.html missing or empty');
  process.exit(1);
}
console.log('\nSMOKE PASS: typecheck clean, build succeeded, dist/index.html present');
