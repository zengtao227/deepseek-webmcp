# P1 live DeepSeek Web acceptance

This is a real-browser gate. Unit tests do not count as P1 success.

## Before testing

1. In Chrome, open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository's `extension/` directory.
3. Open an existing conversation at `https://chat.deepseek.com/`. Prefer an already-created conversation URL so sending the test prompt does not immediately change the route and intentionally disarm the extension.
4. Open the DeepSeek WebMCP popup and click **Arm this conversation**.
5. Keep DevTools Network open if you want to verify that the extension itself does not originate DeepSeek completion requests.

P1 has fake tools only. It cannot read local files or run shell commands.

## Three-turn fake-tool prompt

Isolate one variable at a time (Pitfall 10): first prove observation → parse → continuation → three turns with a call that has **no escapes**; test escape fidelity only after that passes.

Send this as a normal user message in the armed conversation. Do not type in the composer while the loop runs (composer text changes how the Send/Stop control looks). Keep the DeepSeek tab in the foreground for the whole run: Chrome throttles timers in background tabs.

````text
We are testing a browser extension tool protocol. Do not claim that any real local tool was executed.

For your next response, output only one fenced code block (```text) containing exactly this line and nothing else:
<webmcp_tool_call>{"id":"p1_1","name":"read","arguments":{"path":"README.md"}}</webmcp_tool_call>

When you receive the fake WebMCP result, output only the same fenced format with id p1_2 and name bash.
When you receive the second fake result, output only the same fenced format with id p1_3 and name edit.
When you receive the third fake result, answer only: P1 COMPLETE
Use a new call id each time.
````

## Escape-fidelity check (only after the three-turn run passes)

Re-arm and send, as a single turn:

````text
Output only one fenced code block (```text) containing exactly this line and nothing else:
<webmcp_tool_call>{"id":"p1_escape","name":"read","arguments":{"path":"README.md","probe":"中文 quote=\"x\" slash=\\ newline=\\n"}}</webmcp_tool_call>
When you receive the fake WebMCP result, answer only: ESCAPE OK
````

Expected: `loops: 1`, then `ESCAPE OK`. The fence is required: live DeepSeek rendering drops JSON backslash escapes outside code blocks (Finding 8).

## Pass conditions

The run passes only if all are true:

1. The first tool call is detected only after the user arms the current conversation.
2. The extension inserts its fake result into the normal DeepSeek composer and the page sends it successfully.
3. `p1_1 → p1_2 → p1_3 → P1 COMPLETE` runs without manual copy/paste between turns.
4. After the run the popup shows `loops: 3`, `diagnostics.lastCode: "NO_TOOL_CALL"` (from the final answer) and the previous `continuation.code: "SEND_CLICKED"`.
5. Reloading the tab and waiting 10 seconds does not send anything (history is never replayed). A route change should disarm.
6. Malformed-call negative control: re-arm, then send the escape-fidelity instruction **without** the code fence. Measured rendering drops the JSON escapes, so the popup must show `diagnostics.lastCode: "INVALID_JSON"`, `armed: false`, and nothing is sent.
7. No local filesystem/shell capability exists in the extension manifest or code.
8. The extension does not originate or hook DeepSeek network requests and does not read/export DeepSeek credentials.

## Expected failure information

The popup `diagnostics` survive service-worker reconstruction (session storage). If continuation fails, look for:

- `COMPOSER_NOT_FOUND` / `COMPOSER_WRITE_FAILED`
- `SEND_BUTTON_NOT_FOUND` / `SEND_DISABLED` / `SEND_NOT_CONFIRMED`
- a parser code (`INVALID_JSON`, `UNCLOSED_MARKER`, ...)
- the tab was backgrounded: a stall with stale diagnostics may be timer throttling, not selector drift — repeat in the foreground first;
- after `SEND_DISABLED` / `SEND_NOT_CONFIRMED` the fake result text stays in the composer; that is not a partial send;
- `diagnostics: null` after a completed answer while armed: the content script did not observe a generation → completion transition (selector drift).

Do not work around a failed normal UI continuation by adding a private DeepSeek completion client.
