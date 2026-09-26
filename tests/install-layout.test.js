import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HOST_NAME, INSTALL_MARKER } from '../native/host/local-paths.js';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('install.sh puts the program inside the runtime-protected ~/.local/share/webmcp/extension', async () => {
  const sh = await read('install.sh');
  assert.match(sh, /^DIR="\$HOME\/\.local\/share\/webmcp\/extension\/app"$/m);
  assert.ok(sh.includes(`"$DIR/${INSTALL_MARKER}"`), 'install.sh marks the folder with the same marker uninstall checks');
  assert.doesNotMatch(sh, /DeepSeek WebMCP|deepseek-webmcp-install-report/);
});

test('Windows registers the same native host name the WSL side answers to', async () => {
  const ps1 = await read('windows/register.ps1');
  assert.ok(ps1.includes(`$HostName = '${HOST_NAME}'`));
});
