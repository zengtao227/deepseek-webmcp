// Copy-fidelity check for files taken from the ChatGPT Embedded Panel (docs/web-provider-dev-plan.html).
// Usage: node scripts/check-panel-copy.mjs <path-to-chatgpt-embedded-panel>
// Files listed as `exact` must match the source byte for byte (a copied prefix for frame-policy.js).
// Files listed as `diff` are printed as a line diff so every change can be checked against the
// plan's diff list during review.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/check-panel-copy.mjs <path-to-chatgpt-embedded-panel>');
  process.exit(2);
}
const here = (file) => path.join('extension', file);
const there = (file) => path.join(source, file);

const exact = [
  ['embedded-chatgpt.js', 'embedded-chatgpt.js', 'whole'],
  ['frame-policy.js', 'frame-policy.js', 'prefix'],
  ['model-probe.js', 'model-probe.js', 'whole'],
  ['model-status.js', 'model-status.js', 'whole'],
];
const diffed = [
  ['sidepanel-chatgpt.html', 'sidepanel.html'],
  ['sidepanel-chatgpt.js', 'sidepanel.js'],
];

let failed = false;
for (const [mine, theirs, mode] of exact) {
  let a;
  try { a = readFileSync(here(mine), 'utf8'); } catch { continue; }
  const b = readFileSync(there(theirs), 'utf8');
  const ok = mode === 'whole' ? a === b : a.includes(b);
  console.log(`${ok ? 'SAME' : 'DIFFERENT'}  ${mine}  (${mode} of ${theirs})`);
  if (!ok) failed = true;
}
for (const [mine, theirs] of diffed) {
  console.log(`\n=== ${mine} vs ${theirs} (review each change against the plan's diff list)`);
  try {
    execFileSync('diff', ['-u', there(theirs), here(mine)], { stdio: 'inherit' });
    console.log('(identical)');
  } catch {}
}
process.exit(failed ? 1 : 0);
