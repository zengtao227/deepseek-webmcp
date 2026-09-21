# ChatGPT Direct Side Panel Spike

Purpose: answer one question before any production implementation:

> Can the user's normal signed-in `https://chatgpt.com` web session run directly inside a Chrome Side Panel without an API and without modifying frame/security response headers?

This is an isolated diagnostic extension. It does not modify the production DeepSeek WebMCP extension.

## Deliberate constraints

This spike uses only:

- Chrome Side Panel API;
- a normal iframe whose source is `https://chatgpt.com/`;
- a tiny all-frames content script that sends a boolean-style frame-ready handshake.

It does **not** use:

- OpenAI API calls;
- `declarativeNetRequest`;
- `webRequest`;
- CSP or X-Frame-Options removal;
- cookie/session/token export;
- private ChatGPT endpoints;
- DOM automation or prompt injection.

The frame probe records only whether it is top-level, visibility/focus state, document ready state, and URL path. It does not read conversation text or credentials.

## Why this spike exists

Existing open-source ChatGPT side-panel extensions show that the UX is possible, but several use frame-policy overrides. That is not evidence that direct native embedding works under our security boundary. This spike isolates the direct case first.

## Load

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select:

   `$HOME/Doc/My code/deepseek-webmcp/tests/chatgpt-direct-sidepanel-spike`

5. Make sure you are already signed in at `https://chatgpt.com` in a normal tab.
6. Click the **ChatGPT Direct Side Panel Spike** extension icon. Chrome should open its Side Panel.

## Test

1. In the Side Panel click **Load ChatGPT Direct**.
2. Observe the status line and the frame itself.
3. PASS requires all of the following:
   - real ChatGPT UI visibly renders inside the Side Panel;
   - the status reports `PASS candidate: ChatGPT subframe content script is running`;
   - the existing signed-in session is available (no independent broken login/challenge state);
   - you can type and send a normal message in the embedded ChatGPT UI;
   - the reply renders normally in the Side Panel.
4. If the frame is blank, refused, loops on login/challenge, or never produces the subframe handshake, record FAIL and capture the exact visible/browser-console error if available.

Do not add a header override to make a failing direct test pass. That is a separate architecture decision.

## Result recording

Send back:

- the status line;
- what the frame visibly shows;
- whether you were already logged in;
- whether a normal message could be sent and answered.
