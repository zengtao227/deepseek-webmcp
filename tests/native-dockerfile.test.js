import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dockerfile = await readFile(new URL('../native/Dockerfile', import.meta.url), 'utf8');

test('runtime git trusts exactly the /workspace bind so diff inspection works', () => {
  // Live P4 2026-09-15: Docker Desktop shows the bind mount point as root-owned while
  // bash runs as the host UID, so git refused the repo ("dubious ownership") and
  // `git diff` degraded to "Not a git repository".
  assert.match(dockerfile, /git config --system --add safe\.directory \/workspace\n/);
  assert.doesNotMatch(dockerfile, /safe\.directory ['"]?\*/);
});

test('runtime image remains non-root by default', () => {
  assert.match(dockerfile, /^USER 65532:65532$/m);
});
