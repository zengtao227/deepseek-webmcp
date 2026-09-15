# P2 live acceptance — Chrome + Native Messaging + isolated runtime

P2 is not closed by unit tests alone. This gate must run on the owner's macOS Chrome with Docker available.

## Preconditions

- Google Chrome is the baseline browser.
- Docker Desktop / Docker Engine is running.
- The unpacked extension is loaded from this repository's `extension/` directory.
- `npm run check` passes.
- Use this repository itself as the P2 workspace; P2 mounts it read-only.

## Install the P2 Native Messaging host

1. Open `chrome://extensions`.
2. Reload **DeepSeek WebMCP P2**.
3. Copy the extension ID shown by Chrome.
4. In Terminal, from the repository root, run:

```bash
node scripts/install-p2-native-host.mjs \
  --extension-id <CHROME_EXTENSION_ID> \
  --workspace "$(pwd)"
```

The installer:

- builds the P2 Docker image;
- resolves Docker and Node to absolute local paths;
- writes a local config under `~/.deepseek-webmcp/`;
- writes the Native Messaging manifest under Chrome's macOS `NativeMessagingHosts` directory;
- exact-binds `allowed_origins` to the supplied Chrome extension ID.

Reload the extension once after installation. If Chrome reports that the native host cannot be found, fully quit and reopen Chrome once.

## One integrated DeepSeek test

Open an existing `https://chat.deepseek.com/` conversation, keep the tab in the foreground, and **Arm this conversation**.

Send this prompt once. Do not manually continue the conversation after that.

````text
We are running the DeepSeek WebMCP P2 live acceptance test.

Rules:
- Available tools are exactly: open_workspace, read, bash. No other tool exists.
- Do not claim success unless each returned tool result actually shows success.
- Emit exactly ONE WebMCP tool call per response.
- Every tool call must be inside one fenced ```text code block and contain no other text.
- Tool call format (one line, JSON with only id, name, arguments; use a new unique id each time):
  <webmcp_tool_call>{"id":"p2_1","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>
- Reuse the exact workspaceId returned by open_workspace in all later calls.

Step 1: call open_workspace with exactly:
{"path":"/workspace"}

After its real result, Step 2: call read for:
p2-fixture.txt
using the returned workspaceId.

After its real result, Step 3: call bash using the returned workspaceId with:
command: echo P2_OK; printf 'NET='; ls /sys/class/net | tr '\n' ','
timeout: 10

After its real result, Step 4: call read for:
../etc/passwd
using the returned workspaceId.
This step is expected to fail safely with a path escape / denied error. Continue after receiving that error result.

After its real result, Step 5: call bash using the returned workspaceId with:
command: touch /workspace/p2-mutation
timeout: 10
This step is expected to fail because /workspace is read-only. Continue after receiving that error result.

After the fifth tool result, answer only:
P2 COMPLETE
````

## Pass conditions

All must hold:

1. `open_workspace` returns a real `ws_...` workspace ID.
2. `read p2-fixture.txt` returns `DeepSeek WebMCP P2 fixture: READ_OK`.
3. The fixture's fake password value does **not** reach DeepSeek; it appears as `[REDACTED]`.
4. `bash` returns `P2_OK`.
5. The network listing has no real interface such as `eth0`: only `lo` plus the kernel's per-namespace fallback tunnel devices (`gre0`, `sit0`, `ip6tnl0`, `tunl0`, … and the `bonding_masters` sysfs file). Verified 2026-09-15 on Docker Desktop: every non-`lo` device is down, the route table is empty, DNS fails.
6. `read ../etc/passwd` fails closed (`path_escape` / equivalent bounded tool error).
7. `touch /workspace/p2-mutation` fails because `/workspace` is read-only, and no such file appears in the host workspace.
8. DeepSeek reaches `P2 COMPLETE` automatically without manual copy/paste or Send clicks.
9. Popup final state shows `loops: 5`, final `lastCode: NO_TOOL_CALL`, and previous continuation `SEND_CLICKED`.
10. `docker ps -a` shows no leftover `deepseek-webmcp-call-*` containers after the run.
11. Any existing WebMCP Base container named `webmcp-native` is untouched.

## Failure evidence

If the loop stops, do not manually continue. Capture:

- the last DeepSeek response;
- the popup JSON;
- Chrome extension service-worker console error, if any;
- Terminal output of:

```bash
docker ps -a --filter 'name=deepseek-webmcp-call-'
cat "$HOME/.deepseek-webmcp/p2-native-config.json"
```

Do not paste credentials or unrelated browser data.
