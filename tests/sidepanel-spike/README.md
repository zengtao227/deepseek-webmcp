# DeepSeek Side Panel Embed Spike

Purpose: test one question only: can the normal authenticated DeepSeek Web page run directly inside Chrome Side Panel?

This is an isolated test extension. It does not modify the production DeepSeek WebMCP extension.

## Load

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select:
   `$HOME/Doc/My code/deepseek-webmcp/tests/sidepanel-spike`
5. Pin **DeepSeek Side Panel Embed Spike** if useful.
6. Make sure you are already logged in at `https://chat.deepseek.com` in a normal tab.
7. Open any ordinary work page, then click the spike extension icon. Chrome should open its Side Panel.

## Test A — iframe

Click **A. Load DeepSeek in iframe**.

Record:

- Does the actual DeepSeek UI render?
- Is the existing logged-in session reused?
- Can you type and send a normal message?
- Does navigation/history inside DeepSeek work?
- If it fails, inspect the Side Panel DevTools console and copy the exact frame/CSP/X-Frame-Options error.

Success means normal DeepSeek Web is usable inside the extension-owned Side Panel iframe without weakening response security headers.

## Test B — top-level Side Panel navigation

Reset/reopen the spike Side Panel, then click **B. Navigate Side Panel to DeepSeek**.

Record:

- Does the Side Panel itself navigate to the real DeepSeek website?
- Does it remain inside Chrome's Side Panel rather than opening/replacing a normal tab?
- Is the existing logged-in session reused?
- Can you type and send a normal message?
- Does the panel remain usable while switching/working in the main page?

Success here is stronger than Test A because it could avoid iframe frame-ancestor restrictions.

## Do not do in this spike

- Do not remove or rewrite DeepSeek CSP/X-Frame-Options.
- Do not add declarativeNetRequest.
- Do not add ChatGPT.
- Do not add provider abstractions.
- Do not modify the production Browser WebMCP implementation.

## Decision matrix

- A PASS: direct iframe Side Panel is viable; next test is whether the existing DeepSeek DOM adapter/tool loop works in that embedded context.
- A FAIL, B PASS: use top-level DeepSeek navigation in the Side Panel; next test is DOM adapter/tool-loop injection in that context.
- A FAIL, B FAIL: direct normal-site rendering is not viable under Chrome/site policy. Then review a local Side Panel UI backed by a real authenticated DeepSeek Web session/DOM bridge.
- Any path requiring response-header weakening is not accepted merely because it can be made to render; treat that as a separate security decision.

## Recorded result (2026-09-19)

### Test A — iframe

Result: **FAIL**.

Observed:
- The iframe load event fired.
- DeepSeek did not become usable.
- The page showed:

```text
Max challenge attempts exceeded. Please refresh the page to try again!
```

Interpretation: direct iframe embedding is not a reliable basis for V1. No challenge/CSP/header bypass was attempted.

### Test B — top-level Side Panel navigation

Result: **FAIL**.

Observed:
- The spike reported that top-level navigation was starting.
- The Side Panel then remained blank indefinitely.
- Normal DeepSeek Web never became usable in the Side Panel.

Conclusion: both direct-render routes failed. The next architecture candidate is a local Assistant Side Panel UI bridged to a real authenticated DeepSeek Web tab/session. Before panel implementation, the background DeepSeek tab must be proven to keep rendering/streaming and completing the existing tool loop while inactive.

