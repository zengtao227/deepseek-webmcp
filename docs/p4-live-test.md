# P4 live acceptance — coding E2E on a disposable repository

Status: **CLOSED / PASS in the owner's real macOS Google Chrome + Docker environment (2026-09-15).**

P4 is a validation gate on top of P3. It adds no tool, parser, browser-loop, or Native Messaging change. One runtime-image fix was required (see "First run").

## Fixture

A disposable, dependency-free Git repository outside this project:

`~/Doc/My code/deepseek-webmcp-p4-fixture`

- `package.json`: `"test": "node --test"`, no dependencies.
- `src/greeting.js`: `return name ? \`Hello ${name}\` : 'Hello';`
- `test/greeting.test.js`: expects `greeting('Ada') === 'Hello, Ada!'` and `greeting('') === 'Hello!'`.
- One local commit `8508afa test: broken greeting fixture for DeepSeek WebMCP P4`, no remote, no credentials.
- Initial `npm test`: 0 pass / 2 fail.

The development Native Messaging config was pointed at the fixture with the existing installer, then restored to this repository afterwards:

```bash
cd "$HOME/Doc/My code/deepseek-webmcp" && node scripts/install-p2-native-host.mjs --extension-id <CHROME_EXTENSION_ID> --workspace "$HOME/Doc/My code/deepseek-webmcp-p4-fixture"
```

## Prompt

Sent once in a stable `/a/chat/s/<uuid>` conversation after ARM. It states the task, the argument shapes and a five-call budget, but not the fix.

````text
We are running the DeepSeek WebMCP P4 coding acceptance test in a disposable Git repository.

Task: src/greeting.js does not satisfy the existing tests in test/greeting.test.js. Fix the bug by changing only src/greeting.js. Do not modify tests or any other file. Do not commit or push.

Rules:
- Available tools are exactly: open_workspace, read, write, edit, bash. No other tool exists.
- Emit exactly ONE WebMCP tool call per response, inside one fenced ```text code block, with no other text.
- Tool call marker form: <webmcp_tool_call>{"id":"p4_1","name":"open_workspace","arguments":{"path":"/workspace"}}</webmcp_tool_call>
- The JSON inside the markers contains only id, name, arguments. Use a new unique id for every call.
- Reuse the exact workspaceId returned by open_workspace in every later call.
- Argument shapes:
  read: {"workspaceId":"...","path":"relative/path"}
  edit: {"workspaceId":"...","path":"relative/path","edits":[{"oldText":"exact existing text","newText":"replacement"}]}
  bash: {"workspaceId":"...","command":"...","timeout":20}
- You have a budget of exactly 5 tool calls. Do not use extra calls for discovery or retries.

Use this sequence:
1. open_workspace with {"path":"/workspace"}.
2. read src/greeting.js. (The tests expect greeting('Ada') === 'Hello, Ada!' and greeting('') === 'Hello!'.)
3. edit src/greeting.js with one bounded replacement that makes the tests pass.
4. bash: npm test
5. bash: git diff --check && git diff -- src/greeting.js && git status --short

After the fifth tool result, do not call any tool. Reply with a short final answer that states: whether all tests passed, the exact diff you inspected, and whether only src/greeting.js changed.
````

Five tool calls keep the final no-tool answer below `MAX_AGENT_LOOPS` (6), so it is recorded as `NO_TOOL_CALL`.

## First run — FAIL (runtime git)

The code fix and `npm test` (2/2) succeeded, but step 5 returned `Not a git repository`.

Root cause, reproduced through the real dispatcher: Docker Desktop presents the `/workspace` bind mount point as `root`-owned while `bash` runs as the host UID, so git's `safe.directory` protection rejected the repository ("detected dubious ownership") and `git diff` degraded to the non-repository usage error. A pre-flight on the clean fixture had not surfaced it because an empty diff prints nothing.

Fix: `native/Dockerfile` adds `git config --system --add safe.directory /workspace`, trusting only that fixed mount (never `*`). `bash` already has full authority inside `/workspace`, so this grants no new capability. Regression test: `tests/native-dockerfile.test.js`. The image was rebuilt with the existing installer, git was verified through the dispatcher, and the fixture was reset to `8508afa` before rerunning.

## Accepted run — PASS

Conversation: `https://chat.deepseek.com/a/chat/s/34e05e3e-b3d0-4f3b-811e-3c985d19c06a`

Autonomous sequence: `open_workspace` → `read src/greeting.js` → `edit src/greeting.js` → `bash npm test` → `bash git diff --check && git diff -- src/greeting.js && git status --short` → final answer.

DeepSeek's final answer reported 2/2 tests passing, `M src/greeting.js` only, and this diff, identical to the host `git diff`:

```diff
-  return name ? `Hello ${name}` : 'Hello';
+  return name ? `Hello, ${name}!` : 'Hello!';
```

Popup final state:

```json
{"armed": true, "loops": 5, "maxLoops": 6, "diagnostics": {"continuation": {"code": "SEND_CLICKED", "ok": true}, "lastCode": "NO_TOOL_CALL"}}
```

## Pass conditions

1. Baseline `b36e471` = `origin/main`, clean tree, 88/88 tests at start. ✅
2. Fixture initial `npm test` failed (0/2). ✅
3. Fixture has its own initial commit and no remote. ✅
4. Native workspace root pointed only at the fixture during the run. ✅
5. ARMed in a stable `/a/chat/s/<uuid>` conversation. ✅
6. `open_workspace` returned a real `ws_...`. ✅
7. DeepSeek read `src/greeting.js` autonomously. ✅
8. One bounded source replacement; tests unchanged (host `git diff -- test package.json` empty). ✅
9. Fresh one-shot runtimes saw the change (tests and diff ran in later containers). ✅
10. `npm test` passed in the network-disabled runtime. ✅
11. DeepSeek ran and inspected `git diff --check` + source diff. ✅ (after the image fix)
12. Diff contains only the expected source change; host `git status` shows only `M src/greeting.js`. ✅
13. Final answer produced automatically, no manual copy or Send. ✅
14. Five tool calls. ✅
15. Popup `loops: 5`, `lastCode: NO_TOOL_CALL`, previous continuation `SEND_CLICKED`. ✅
16. No non-allowlisted tool executed. ✅
17. No `deepseek-webmcp-call-*` containers remained. ✅
18. Base `webmcp-native` untouched (same container, `StartedAt` unchanged). ✅
19. Production repo changed only by the reviewed image fix, its test, and these docs. ✅
20. No DeepSeek API, private completion request, or network interception. ✅
21. Runtime still `--network none` (unchanged docker argv). ✅
22. Fixture mutation not committed or pushed (fixture log still `8508afa`). ✅
23. No Git credential mount or exposure. ✅
24. Native workspace root restored to `~/Doc/My code/deepseek-webmcp`. ✅

> 2026-09-21: the fixture folder was moved to the Trash after P4 acceptance (a one-commit test repo, clean, no remote). The workspace is now the owner's real folder, chosen in the panel Settings.
