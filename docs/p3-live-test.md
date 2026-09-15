# P3 live acceptance — writable bounded coding loop

Status: **CLOSED / PASS in the owner's real macOS Google Chrome + Docker environment (2026-09-15).** All 12 pass conditions below were satisfied. This document records the live gate and its acceptance evidence.

## What P3 proves

P2 already proved the browser continuation loop, one-shot Native Messaging lifecycle, deterministic workspace identity, Docker isolation, no real runtime network connectivity, Secret Firewall, and read-only boundary.

P3 changes only the mutation surface:

- browser-visible tools become exactly `open_workspace`, `read`, `write`, `edit`, `bash`;
- the owner-selected `/workspace` bind becomes writable so changes persist across fresh one-shot containers;
- the bind is non-recursive (`bind-recursive=disabled`);
- all other P2 isolation and browser-loop controls remain in force.

Because `bash` runs in the same writable workspace, it can mutate files too. `write/edit` are structured bounded mutation tools; they are not the exclusive mutation path.

## Preconditions

- Google Chrome is the baseline browser.
- Docker Desktop / Docker Engine is running.
- The unpacked extension is loaded from this repository's `extension/` directory.
- `npm run check` passes.
- Git working tree contains only the intended P3 implementation changes before the live test.
- No commit or push is required for this gate.

## Refresh the development Native Messaging installation

P3 intentionally reuses the existing P2 development installer instead of creating phase-specific packaging. The script rebuilds the current runtime image and refreshes the fixed owner-selected workspace configuration.

From the repository root, run:

```bash
node scripts/install-p2-native-host.mjs \
  --extension-id <CHROME_EXTENSION_ID> \
  --workspace "<separate project directory>"
```

> Since `f1a5dd6` the workspace must not contain this repository (host code runs from it). These historical runs used the repository root; to repeat them, use a separate directory.

Then reload the unpacked Chrome extension once.

## One integrated DeepSeek test

Open an **existing DeepSeek conversation whose URL is already stable at `https://chat.deepseek.com/a/chat/s/<uuid>`**, keep that tab in the foreground, and then **Arm this conversation**. Do not arm on the blank `/` route before sending the first message: DeepSeek's SPA route change to `/a/chat/s/<uuid>` correctly DISARMs by design.

Send the following prompt once. Do not manually continue between tool turns.

````text
We are running the DeepSeek WebMCP P3 live acceptance test.

Rules:
- Available tools are exactly: open_workspace, read, write, edit, bash. No other tool exists.
- Do not use list_directory, glob, grep, git, or any other tool name.
- Do not claim success unless each returned tool result actually shows success or the explicitly expected safe failure.
- Emit exactly ONE WebMCP tool call per response.
- Every tool call must be inside one fenced ```text code block and contain no other text.
- Every tool call must use this exact marker form inside the fenced block: <webmcp_tool_call>{"id":"p3_1","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>
- The JSON inside the markers must contain only id, name, arguments.
- Use a new unique id for every call.
- Reuse the exact workspaceId returned by open_workspace in every later call.

Step 1: emit exactly:
<webmcp_tool_call>{"id":"p3_1","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>

After its real result, Step 2: call write for:
path: p3-live.txt
content: alpha
using the returned workspaceId.

After its real result, Step 3: call read for:
p3-live.txt
using the returned workspaceId.
The result must contain alpha.

After its real result, Step 4: call edit using the returned workspaceId. The arguments must have exactly this shape (replacements go inside the edits array, never as top-level oldText/newText):
{"workspaceId":"<returned workspaceId>","path":"p3-live.txt","edits":[{"oldText":"alpha","newText":"beta"}]}

After its real result, Step 5: call bash using the returned workspaceId with:
command: test "$(cat p3-live.txt)" = "beta" && rm p3-live.txt && echo P3_OK
timeout: 10
The result must contain P3_OK.

After its real result, Step 6: call write using the returned workspaceId for:
path: ../p3-escape.txt
content: SHOULD_NOT_EXIST
This step is expected to fail safely with path_escape or an equivalent workspace-boundary error. Continue after receiving that expected error result.

After the sixth tool result, answer only:
P3 COMPLETE
````

## Pass conditions

All must hold:

1. `open_workspace` returns a real `ws_...` workspace ID.
2. `write p3-live.txt` succeeds and the next fresh one-shot container can read `alpha`.
3. `edit` succeeds and the next fresh one-shot container sees `beta`.
4. `bash` verifies `beta`, removes the fixture, and returns `P3_OK`.
5. `write ../p3-escape.txt` fails closed and no escape file is created outside the selected workspace.
6. DeepSeek reaches `P3 COMPLETE` automatically without manual copy/paste or Send clicks.
7. Popup final state shows `armed: false`, final `lastCode: LOOP_LIMIT`, and previous continuation `SEND_CLICKED`. With exactly six tool calls the final `P3 COMPLETE` completion reaches `MAX_AGENT_LOOPS` (6), and `acceptCompletion` checks the bound before parsing, so the loop ends fail-closed by design. Any extra or retried tool call makes the sixth step hit `LOOP_LIMIT` early instead, which is a failure.
8. The conversation never emits or executes `list_directory` or another non-allowlisted tool.
9. `p3-live.txt` is absent after Step 5 and no `p3-escape.txt` was created beside the repository.
10. `docker ps -a` shows no leftover `deepseek-webmcp-call-*` containers after the run.
11. Any existing WebMCP Base container named `webmcp-native` remains untouched.
12. No commit or push occurs.

## Failure evidence

If the loop stops, do not manually continue. Capture the last DeepSeek response, popup JSON, and extension service-worker console error if any. For native/runtime failures also capture the current development config and leftover call containers, without pasting credentials or unrelated browser data.
