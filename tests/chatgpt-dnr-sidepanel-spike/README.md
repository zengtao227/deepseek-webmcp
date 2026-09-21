# ChatGPT Scoped DNR Side Panel Spike

Purpose: determine the minimum frame-policy override required for the user's normal signed-in `https://chatgpt.com` session to run directly inside Chrome Side Panel.

This is a second isolated spike. The earlier direct/native iframe spike remains unchanged as the baseline failure evidence.

## Why this test

The direct iframe produced a load event but no ChatGPT subframe content-script handshake. Multiple open-source ChatGPT side-panel projects solve the same class of problem by removing frame-blocking response headers with Manifest V3 `declarativeNetRequest`.

This spike narrows that approach as much as practical:

- only `https://chatgpt.com/*` is in host permissions;
- the rule matches only `sub_frame` requests;
- the rule matches only requests whose initiator is this extension (`initiatorDomains: [chrome.runtime.id]`);
- the rule is a session rule, not a persistent static/global rule;
- no request or response body is inspected;
- no cookies, tokens, account state, prompt text, or conversation text are read;
- no OpenAI API or private endpoint is used.

The rule therefore does not alter ordinary top-level ChatGPT tabs or ChatGPT frames initiated by normal websites.

## Two gates

### Gate A — remove X-Frame-Options only

This is the least invasive override. If it works, stop there.

### Gate B — remove X-Frame-Options + Content-Security-Policy

Run only if Gate A still does not load ChatGPT. This is broader because removing the whole CSP response header also removes directives unrelated to `frame-ancestors`; Chrome DNR cannot surgically delete one CSP directive.

## Load

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select:

   `$HOME/Doc/My code/deepseek-webmcp/tests/chatgpt-dnr-sidepanel-spike`

5. Make sure a normal `https://chatgpt.com` tab is already signed in.
6. Click the **ChatGPT Scoped DNR Side Panel Spike** extension icon.

## Test Gate A

1. Click **Test XFO only**.
2. Confirm the status area says `mode=xfo; ruleInstalled=true`.
3. Inspect the frame.
4. PASS requires:
   - a `PASS candidate: ChatGPT subframe handshake` status;
   - the real signed-in ChatGPT UI visibly renders;
   - you can manually send `hello` in the embedded UI;
   - the reply renders normally.
5. If Gate A fails, record the visible result and continue to Gate B.

## Test Gate B

1. Click **Test XFO + CSP**.
2. Confirm `mode=xfo-csp; ruleInstalled=true`.
3. Inspect the fresh frame.
4. Apply the same PASS criteria above.

If Gate B still fails, do not add more header removal. At that point the likely blockers are session/cookie/frame behavior beyond the two standard frame-policy headers, and the provider-window fallback should be tested instead.

## Clean up

Click **Rule off** after testing. The rules are session-scoped, but explicit off is preferable during development.

## Report back

For each gate send:

- status text;
- whether `ruleInstalled=true`;
- what the frame visibly shows;
- whether the existing login is preserved;
- whether a normal message can be sent and answered.
