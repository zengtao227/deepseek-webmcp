import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const { artifactId: PINNED_ARTIFACT } = JSON.parse(await readFile(new URL('../../runtime.lock.json', import.meta.url), 'utf8'));

// The smallest pinned release the host accepts: loaders that pass verification. Tests add the
// scripts they fake (the host relay start.js, the instance controller).
const LOADER_STUBS = {
  'adapter/deploy/deploy-host-runtime.js': 'export async function verifyRelease() {}',
  'native/deploy/instance-context.js': 'export function createInstanceContext({ instanceId }) { return { instanceId }; }',
  'native/deploy/instance-release.js': `import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  export async function verifyPinnedInstanceRelease() {
    const releaseRoot = fileURLToPath(new URL('../..', import.meta.url));
    return { artifactId: path.basename(releaseRoot), releaseRoot };
  }`,
  'native/deploy/elevated-access.js': '',
  'native/deploy/workspace-config.js': '',
  'native/host/host-command.js': '',
  'native/deploy/instance-lock.js': '',
};

export async function writePinnedRelease(home, scripts = {}) {
  const releaseRoot = path.join(home, '.local', 'share', 'webmcp', 'host-runtime', 'releases', PINNED_ARTIFACT);
  for (const [file, text] of Object.entries({ ...LOADER_STUBS, ...scripts })) {
    await mkdir(path.dirname(path.join(releaseRoot, file)), { recursive: true });
    await writeFile(path.join(releaseRoot, file), `${text}\n`);
  }
  return releaseRoot;
}
