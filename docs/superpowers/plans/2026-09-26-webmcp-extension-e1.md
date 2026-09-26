# WebMCP Extension E1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Web Provider extension into the WebMCP Extension whose local program runs through one shared WebMCP instance (`webmcp`) that the WebMCP App manages, so the App shows "WebMCP Extension" with folders, Write switches and Host Access.

**Architecture:** Start from `feat/web-provider-chatgpt`; merge the two-level P1 changes (runtime v0.3.0 pin, Settings Full access removed) and the shared-instance work S1–S4. Rename the instance, native host and state directory to WebMCP names; install the program under the runtime-protected `~/.local/share/webmcp/extension/`; the panel shows access and Revoke only (folders and grants move to the App on macOS). Migration moves the old DeepSeek folder into the new instance.

**Tech Stack:** Chrome MV3 extension (plain ES modules), Node 22 native host, webmcp-runtime v0.3.0 (pinned, published), WebMCP App (Swift, in webmcp-bridge `p1/two-access-levels`).

**Spec:** `docs/superpowers/specs/2026-09-26-webmcp-extension-design.md` (read it first).

## Global Constraints

- Two access levels only: mounted folders (per-folder Write) and Host Access. No Full access anywhere.
- The panel never grants authority on macOS; grants happen only in the WebMCP App behind the macOS dialog. Revoke stays in the panel.
- WSL keeps its one-shot container and its folder choice in the panel (no App there); only macOS uses the instance.
- Runtime stays pinned to v0.3.0 (`runtime.lock.json` artifact `20d14df9a3df1d2fc06fff107f6c997a2dca7e06-01f02f868e2f060268cd7fdbf418c83a8014427129c837c9a748b113760b7bfb`). No runtime release in E1.
- Docker-Hub-free install is E4, not E1 (reference patches: `~/Doc/webmcp-bridge-work/base-image-reference/`).
- Keep the extension manifest `key` (extension ID unchanged).
- Nothing on the owner's Mac changes until Task 8, and Task 8 needs the owner's go.
- Commit per task; do not push until Task 8 passes; never commit `node_modules`.

---

### Task 0: E1 branch

**Files:** none (git only).

- [ ] **Step 1:** Commit S1–S4 on its own branch (they are uncommitted in `~/Doc/deepseek-webmcp-work/shared-instance`, branch `feat/shared-instance-workspace`):

```bash
cd ~/Doc/deepseek-webmcp-work/shared-instance
npm run check   # expect 358/358 pass
git add native tests docs/shared-instance-design.md .agent
git commit -m "feat: DeepSeek workspace tools run in the shared WebMCP instance (S1-S4)"
```

- [ ] **Step 2:** Create the E1 worktree from the pushed Web Provider branch:

```bash
cd "~/Doc/My code/deepseek-webmcp"
git fetch origin
git worktree add -b e1/webmcp-extension ~/Doc/webmcp-extension-work/e1 origin/feat/web-provider-chatgpt
cd ~/Doc/webmcp-extension-work/e1 && ln -s ../../deepseek-webmcp-work/shared-instance/node_modules node_modules
```

- [ ] **Step 3:** Merge the two-level P1 code (stop before the cancelled v0.7.1 pin commit 8a3e10a):

```bash
git merge --no-ff 8cf114f -m "merge: two access levels (P1 8cf114f)"
```
Expected conflict: `README.md` only. Resolve by taking the P1 branch's access paragraph (folder + Host Access; no Full access), keep everything else from Web Provider.

- [ ] **Step 4:** Merge S1–S4: `git merge --no-ff feat/shared-instance-workspace -m "merge: shared instance S1-S4"`. Resolve conflicts keeping both sides' intent (S2 panel access line + P1 Settings removal).
- [ ] **Step 5:** `npm run check` → all pass. Record the count in `.agent/handoff.md`.

---

### Task 1: WebMCP identity (instance, host, state directory, name)

**Files:**
- Modify: `native/host/host-access.js` (`INSTANCE_ID`), `native/host/local-paths.js` (`HOST_NAME`, `INSTALL_MARKER`, `stateDir`), `extension/native-client.js` (`HOST_NAME`), `extension/manifest.json` (`name`, `description`), `windows/*` registry names if they embed the host name
- Test: `tests/host-access.test.js`, `tests/instance-dispatch.test.js`, `tests/instance-migration.test.js`, `tests/windows-host.test.js`, a new `tests/identity.test.js`

**Interfaces:**
- Produces: `INSTANCE_ID = 'webmcp'`; `HOST_NAME = 'com.webmcp.extension'`; `stateDir(home) = <home>/.local/share/webmcp/extension`; `configPath(home) = stateDir/p2-native-config.json` (file name kept).

- [ ] **Step 1: Write the failing test** `tests/identity.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HOST_NAME, stateDir } from '../native/host/local-paths.js';
import { INSTANCE_ID } from '../native/host/host-access.js';

test('the extension is WebMCP: one instance, one host, state under the protected WebMCP folder', async () => {
  assert.equal(INSTANCE_ID, 'webmcp');
  assert.equal(HOST_NAME, 'com.webmcp.extension');
  assert.equal(stateDir('/Users/me'), '/Users/me/.local/share/webmcp/extension');
  const client = await readFile(new URL('../extension/native-client.js', import.meta.url), 'utf8');
  assert.match(client, /const HOST_NAME = 'com\.webmcp\.extension';/);
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'WebMCP');
});
```

- [ ] **Step 2:** `node --test tests/identity.test.js` → FAIL.
- [ ] **Step 3:** Change the constants:

```js
// native/host/host-access.js
export const INSTANCE_ID = 'webmcp';
// native/host/local-paths.js
export const HOST_NAME = 'com.webmcp.extension';
export const INSTALL_MARKER = '.webmcp-extension-installed';
// Inside ~/.local/share/webmcp, which every WebMCP runtime masks from every container.
export function stateDir(home = os.homedir()) {
  return path.join(home, '.local', 'share', 'webmcp', 'extension');
}
// extension/native-client.js
const HOST_NAME = 'com.webmcp.extension';
```
`extension/manifest.json`: `"name": "WebMCP"`, description "WebMCP — AI providers in one Side Panel, local work through the WebMCP App." Keep `key`.
Rename `removeDeepSeekInstance` → `removeExtensionInstance` (same body, uses `INSTANCE_ID`).

- [ ] **Step 4:** Update the tests that hard-code `deepseek` / `com.deepseek.webmcp.native` / `.deepseek-webmcp` (grep them). `npm run check` → all pass.
- [ ] **Step 5:** Commit `feat: WebMCP identity — instance webmcp, host com.webmcp.extension, protected state folder`.

---

### Task 2: Program installed inside the protected folder

**Files:**
- Modify: `install.sh` (`DIR`), `scripts/install-p2-native-host.mjs` (launcher path already under `stateDir`), `scripts/uninstall.mjs`
- Test: `tests/install-layout.test.js` (new)

**Why:** a mounted folder or `host_command` must never be able to rewrite the program Chrome runs. `~/.local/share/webmcp` is in every WebMCP runtime's protected-path list, so a program there is masked from every container.

- [ ] **Step 1: Failing test** `tests/install-layout.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('install.sh puts the program inside ~/.local/share/webmcp/extension', async () => {
  const sh = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(sh, /^DIR="\$HOME\/\.local\/share\/webmcp\/extension\/app"$/m);
  assert.doesNotMatch(sh, /deepseek-webmcp-install-report/);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `install.sh`: `DIR="$HOME/.local/share/webmcp/extension/app"`, report file `$HOME/webmcp-extension-install-report.txt`, user-facing text "WebMCP" instead of "DeepSeek WebMCP", `open -R "$DIR/extension"` unchanged. `install-p2-native-host.mjs`: manifest `description: 'WebMCP Extension local program'`.
- [ ] **Step 4:** `bash -n install.sh`; `npm run check` → pass.
- [ ] **Step 5:** Commit `feat: install the WebMCP program inside the runtime-protected WebMCP folder`.

---

### Task 3: Panel shows access and Revoke only (macOS)

**Files:**
- Modify: `extension/settings-ui.js`, `extension/sidepanel.html`, `extension/native-client.js` (`CONTROLS`), `extension/background.js` (`runControl` args), `native/host/control.js`
- Test: `tests/panel-header.test.js`, `tests/native-host-dispatch.test.js`, `tests/windows-host.test.js`, `tests/background-conversation-key.test.js`

**Interfaces:**
- `status` result on macOS: `{ capabilities: { chooseFolder: false, hostAccessGrant: false }, folders, fullAccessUntil: null, hostAccessUntil, leaseState, hostAccessState }`; on WSL `{ capabilities: { chooseFolder: true, hostAccessGrant: false }, folder, folders, … }`.
- Controls accepted: `status`, `stop-host-access`, `uninstall` everywhere; `choose-folder` only when `kind === 'wsl'`; `grant-host-access` removed.

- [ ] **Step 1: Failing tests** (add to `tests/native-host-dispatch.test.js`):

```js
test('on macOS the panel cannot choose a folder or grant Host Access; the App does', async () => {
  const { handleControlRequest, validateControlRequest } = await import('../native/host/control.js');
  assert.throws(() => validateControlRequest({ version: 1, id: 'x', control: 'grant-host-access', arguments: { minutes: 5 } }), { code: 'CONTROL_NOT_ALLOWED' });
  await assert.rejects(
    handleControlRequest({ version: 1, id: 'x', control: 'choose-folder', arguments: {} }, { kind: 'macos', configFile: '/nonexistent' }),
    { code: 'MANAGED_BY_WEBMCP_APP' },
  );
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `control.js`: drop `grant-host-access` from `CONTROL_ARGUMENTS` and its handler; `choose-folder` on macOS fails with `MANAGED_BY_WEBMCP_APP` ("Folders and Host Access are managed in the WebMCP App."). `capabilities` as above. `settings-ui.js`: remove the Host Access grant block and, when `capabilities.chooseFolder === false`, hide `#choose` and show "Folders and Host Access: WebMCP App (menu bar)". `sidepanel.html`: remove `#host-access-section` grant controls (keep nothing that grants). `native-client.js` `CONTROLS = new Set(['status', 'choose-folder', 'stop-host-access', 'uninstall'])`. `background.js` `runControl`: no argument-carrying controls remain → `const allowedArgs = {};`.
- [ ] **Step 4:** Update the affected tests; `npm run check` → pass.
- [ ] **Step 5:** Commit `feat: the panel shows access and Revoke; folders and grants live in the WebMCP App`.

---

### Task 4: Migration into the `webmcp` instance

**Files:**
- Modify: `native/host/instance-migration.js`, `scripts/install-p2-native-host.mjs`
- Test: `tests/instance-migration.test.js`

**Interfaces:**
- `planInstanceMigration({ context, workspaceRoot, release, legacy, platform })` where `legacy = { deepseekContext, oldStateDir }`; returns `{ provision, root, additions, cleanup: { removeInstanceDirs: string[], removeContainers: string[], removeFiles: string[] } }`.
- Folder sources, in order: the `webmcp` instance's existing folders (kept as they are), the old `deepseek` instance's legacy root or mounts (with their Write switches), the old `~/.deepseek-webmcp/p2-native-config.json` `workspaceRoot` (Write ON), the installer's `workspaceRoot` (Write ON). Duplicates are skipped by the runtime's duplicate-id rule.
- Cleanup after success: `~/.config/webmcp/instances/deepseek`, `~/.local/share/webmcp/instances/deepseek`, container `webmcp-native-deepseek` if present, old host manifests `com.deepseek.webmcp.native.json` in every browser profile root, `~/.deepseek-webmcp`. The old program folder `~/deepseek-webmcp` is **not** removed in E1 (the old unpacked extension may still point at it); `doctor` reports it.

- [ ] **Step 1: Failing tests** (extend `tests/instance-migration.test.js` fixtures with a legacy `deepseek` context and an old state dir):

```js
test('folders from the old DeepSeek instance and old state move into the webmcp instance with their Write switches', async () => {
  // fixture: deepseek instance legacy root /P (readOnly true); old state workspaceRoot /Q; installer root /Q
  // expect additions: [{ root: '/P', write: false }, { root: '/Q', write: true }]
  // expect cleanup to list the deepseek instance dirs, container webmcp-native-deepseek, old manifests, old state dir
});
test('a second run changes nothing and removes nothing that is already gone', async () => { /* additions [], cleanup of absent paths is a no-op */ });
test('an active lease on either instance stops setup before any change', async () => { /* both webmcp and deepseek lease paths */ });
```
Write these with the existing `fakeRelease()` / `withInstance()` helpers in that file (extend `withInstance` to also create `deepseekContext` with `instanceId: 'deepseek'`).

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: `planInstanceMigration` reads the legacy sources above (via `release.workspace.loadWorkspaceConfig` / `release.mounts.loadWorkspaceMountConfig`), refuses when either instance has a lease file, builds `additions` through `release.mounts.addWorkspaceMount` dry runs (unchanged rule), and returns `cleanup`. `migrateToInstance` runs the additions (unchanged), then cleanup (`rm` with `{ recursive: true, force: true }` for dirs, `removeContainer` for containers, `rm` for files). The installer passes `legacy: { deepseekContext: createInstanceContext({ home, instanceId: 'deepseek' }), oldStateDir: path.join(home, '.deepseek-webmcp') }` and adds the cleanup targets to `beginInstall` files so a failed install restores them.
- [ ] **Step 4:** `npm run check` → pass.
- [ ] **Step 5:** Commit `feat: migrate the old DeepSeek instance and state into the webmcp instance`.

---

### Task 5: doctor and uninstall know the instance

**Files:**
- Modify: `scripts/doctor.mjs`, `scripts/uninstall.mjs`, `native/host/host-access.js` (`removeExtensionInstance`)
- Test: `tests/doctor.test.js` (new, using `tests/fixtures/pinned-release.js` with a fake controller)

- [ ] **Step 1: Failing test:** doctor on macOS reports OK only when `access-status --instance webmcp` answers and `mount-list` lists at least one folder; it reports the leftover `~/deepseek-webmcp` as "old DeepSeek program folder — remove after checking the new extension".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `doctor.mjs` on macOS: replace the docker `open_workspace` probe with `runInstanceControl('access-status')` + `runInstanceControl('mount-list')` + one `dispatchInstanceRequest` `open_workspace`; WSL keeps the old probe. `removeExtensionInstance` also runs `docker rm --force webmcp-native-webmcp` (ignore "No such container").
- [ ] **Step 4:** `npm run check` → pass.
- [ ] **Step 5:** Commit `feat: doctor and uninstall check and remove the webmcp instance`.

---

### Task 6: WebMCP App names the instance

**Repo:** webmcp-bridge, new branch `e1/webmcp-extension-label` from `origin/p1/two-access-levels` in a fresh worktree.

**Files:** Modify `native/menubar/main.swift` (`instanceDisplayNames`), `tests/native-menubar.test.js`.

- [ ] **Step 1: Failing self-test** in `main.swift` self-tests:

```swift
try require(instanceDisplayName("webmcp") == "WebMCP Extension", "the extension's instance is named for the extension")
```
- [ ] **Step 2:** `npm run test:menubar` → FAIL.
- [ ] **Step 3:** `instanceDisplayNames = ["default": "ChatGPT Side Panel", "webmcp": "WebMCP Extension", "prism": "Prism"]` (drop `deepseek`). Update the self-test lines that expected the `deepseek` label.
- [ ] **Step 4:** `npm run test:menubar` PASS; `npm run lint`; `npm test`.
- [ ] **Step 5:** Commit `feat: the App names the webmcp instance "WebMCP Extension"`.

---

### Task 7: Independent review

- [ ] Dispatch a read-only reviewer on the E1 diff (`git diff origin/feat/web-provider-chatgpt...e1/webmcp-extension`) and the Bridge label diff, with these items: host_command gate and lease handling unchanged in strength; no path lets the panel grant authority on macOS; the program and state are under `~/.local/share/webmcp`; migration preflight covers every refusal before writes and rollback restores files and removes only the new container; WSL behaviour unchanged; tests would fail on regression.
- [ ] Fix blocking findings; re-run `npm run check`.

---

### Task 8: Owner-Mac migration and acceptance (needs the owner's go)

- [ ] Record baseline: `~/.config/webmcp/instances/*`, `~/.local/share/webmcp/instances/*`, `~/.deepseek-webmcp`, browser NativeMessagingHosts listings, `docker ps -a`, `docker image ls`.
- [ ] Build: `node scripts/build-release.mjs --out <dir> --commit HEAD`; runtime archive = published v0.3.0.
- [ ] Install: `DEEPSEEK_WEBMCP_ADAPTER_URL=<archive> DEEPSEEK_WEBMCP_ADAPTER_SHA256=<sha> DEEPSEEK_WEBMCP_RUNTIME_ARCHIVE=<v0.3.0 archive> bash install.sh` (env names unchanged in E1).
- [ ] Rebuild and start the App from the Bridge label branch (`~/Applications/WebMCP Menu.app`).
- [ ] Owner checks in the App: "WebMCP Extension" with Add Folder, Write ON/OFF and Host Access grant/revoke; the old DeepSeek folder is there with Write ON.
- [ ] Owner removes the old DeepSeek WebMCP extension in Chrome and loads `~/.local/share/webmcp/extension/app/extension`; DeepSeek and ChatGPT web each complete one real tool call; Revoke in the panel ends Host Access.
- [ ] Rollback if needed: remove `com.webmcp.extension` manifests and the `webmcp` instance, restore the saved `~/.deepseek-webmcp` and `deepseek` instance dirs, reload the old extension from `~/deepseek-webmcp/extension`.
- [ ] Rename the GitHub repository `zengtao227/deepseek-webmcp` → `zengtao227/webmcp-extension` (`gh repo rename webmcp-extension -R zengtao227/deepseek-webmcp`); GitHub redirects the old URLs. Update local remotes with `git remote set-url origin https://github.com/zengtao227/webmcp-extension.git`.
- [ ] Push `e1/webmcp-extension` and the Bridge label branch; update `.agent/handoff.md` and `~/Doc/webmcp-bridge-work/TWO-LEVELS-PLAN.md`.
