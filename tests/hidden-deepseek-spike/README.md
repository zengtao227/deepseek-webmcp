# DeepSeek Hidden-Tab Streaming Spike

Purpose: prove or reject the key Compact Assistant assumption before writing Side Panel product code:

> Can a normal authenticated DeepSeek Web tab, after being hidden for more than six minutes, accept an extension-submitted prompt and keep growing the assistant-answer DOM while still hidden?

This is an isolated diagnostic extension. It does not modify the production DeepSeek WebMCP extension.

It intentionally uses no polling timers for the measurement. It records only:

- timestamp and `document.visibilityState`;
- event kind;
- the existing final-answer selector count/length;
- broader candidate DOM counts/lengths for `.ds-markdown`, `.ds-message`, and `.ds-think-content`;
- whether the existing DeepSeek Stop icon says generation is active;
- composer length and Send disabled state;
- lifecycle signals such as `freeze`, `resume`, `pagehide`, and `pageshow`.

The broader telemetry was added after the first hidden >8 minute run proved that the content script remained alive and could click Send, but the final-answer selector stayed at zero while hidden DOM mutations continued.

It does **not** record answer text, prompt text, cookies, tokens, storage secrets, or credentials.

## Load

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select:

   `$HOME/Doc/My code/deepseek-webmcp/tests/hidden-deepseek-spike`

5. Open or reload a normal authenticated `https://chat.deepseek.com` tab after loading the spike.
6. Start a fresh empty DeepSeek conversation.

## Bind

While the DeepSeek tab is active:

1. Click the **DeepSeek Hidden Tab Spike** extension icon.
2. Click **Bind current DeepSeek tab**.
3. Expect a status similar to:

   `Bound DeepSeek tab <id>. Visibility: visible.`

4. Click **Clear log**.
5. Close the popup.

## Sanity check before waiting

1. Switch from DeepSeek to an ordinary work tab.
2. Open the spike popup on the work tab.
3. Click **Refresh log**.

Expected:
- fetching the log succeeds;
- current visibility reports `hidden`;
- the lifecycle log includes a `visibilitychange` event.

If this fails, stop and report the popup status; do not wait six minutes.

## Formal hidden >6 minute gate

1. Stay away from the bound DeepSeek tab for at least **6 full minutes**.
2. Do not preview, activate, or switch back to DeepSeek during this interval.
3. On the ordinary work tab, open the spike popup.
4. Click **Send hidden probe**.
5. Expect a result such as `SUBMIT_CLICKED` or `SUBMIT_WAITING_FOR_ENABLED_CONTROL`.
6. Keep DeepSeek hidden.
7. After about 60–90 seconds, open the spike popup again **without switching to DeepSeek**.
8. Click **Refresh log**.

The popup computes a candidate result from the log.

## PASS evidence

The critical evidence is repeated entries after `submit_received` where:

- `visibility` remains `hidden`; and
- `answerLength` increases multiple times.

For example:

```text
hidden answer growth events: 20
max answer length observed hidden: 6000
candidate result: PASS — answer DOM grew repeatedly while hidden
```

This proves that the DeepSeek answer DOM itself continued to render/grow while hidden after Chrome's >5 minute intensive timer-throttling threshold.

## NOT PROVEN / FAIL evidence

Any of these need investigation before Compact Assistant implementation:

- the bound content script stops responding while hidden;
- hidden prompt submission cannot manipulate the composer/send control;
- no new assistant answer appears while hidden;
- answer length stays flat while hidden and grows only after DeepSeek becomes visible again;
- a `freeze`, `pagehide`, or discard/reload event occurs;
- the probe cannot fetch logs until the DeepSeek tab is reactivated.

Do **not** reactivate DeepSeek before first fetching/copying the hidden-state log, because that would destroy the key evidence.

## Share the result

Click **Copy log** and send:

1. the summary shown above the log;
2. the copied JSON log if the result is ambiguous.

No production code should be changed based on this spike until the result is known.

## Recorded Spike 0.1 result (2026-09-19)

Observed after keeping DeepSeek hidden for about 6m58s before submission:

- hidden content script remained reachable;
- hidden prompt submission succeeded;
- composer cleared;
- existing Stop-icon telemetry reported `generating=true` while hidden, then later returned false;
- no freeze/pagehide/discard signal was observed;
- all tracked answer/content DOM counts and lengths remained zero while hidden:
  - final answer selector;
  - `.ds-markdown`;
  - `.ds-message`;
  - `.ds-think-content`.

Interpretation: DeepSeek's hidden tab can process the prompt and run a generation cycle, but the answer-content DOM was not rendered in the tracked document while hidden.

The confirmation test was completed.

### Confirmation result

While DeepSeek remained hidden, the generation cycle completed but all tracked answer/content DOM stayed at zero.

When the same DeepSeek tab became visible at `2026-09-19T12:51:36.338Z`, the answer DOM appeared almost immediately:

- `answerCount: 1`
- `answerLength: 12774`
- `markdownCount: 1`
- `latestMarkdownLength: 12774`
- `messageCount: 2`
- `latestMessageLength: 12774`

The first populated answer snapshot was recorded at `2026-09-19T12:51:36.411Z`, about 73 ms after the visibility change.

Conclusion: DeepSeek can process a prompt and finish generation while hidden, but the answer-content DOM is visibility-dependent and does not render in the hidden tab. Therefore a Compact Assistant that mirrors DeepSeek purely from the hidden page DOM is blocked under the current DOM-only architecture.

## Separate-window foreground-tab test

This is the last Compact Assistant viability test before falling back to Chrome Split View.

Goal: keep DeepSeek as the selected tab in a second, non-minimized Chrome window while the user works in a different Chrome window.

Required evidence:

- DeepSeek reports `visibility: visible`;
- DeepSeek reports `hasFocus: false`;
- a prompt can be submitted from the work window;
- DeepSeek reports `generating=true`;
- answer/markdown/message DOM lengths grow while `visibility=visible` and `hasFocus=false`.

### Steps

1. Reload **DeepSeek Hidden Tab Spike** in `chrome://extensions`.
2. Put DeepSeek in its own Chrome window (Window B).
3. Keep DeepSeek selected as Window B's current tab. Do not minimize Window B.
4. On DeepSeek, open a fresh empty conversation.
5. Open the spike popup in Window B, click **Bind current DeepSeek tab**, then **Clear log**.
6. Switch focus to your normal work window (Window A). Do not click another tab inside Window B.
7. In Window A, open the spike popup and click **Refresh log**.

Expected checkpoint:

```text
current visibility: visible
current hasFocus: false
```

If it says `visibility: hidden`, stop: this window arrangement does not preserve render visibility.

8. Still from Window A, click **Send probe**. If the stored binding was lost, the popup now auto-discovers the unique DeepSeek tab that has the spike content script loaded. If multiple DeepSeek tabs exist, explicitly Bind the intended one first.
9. Keep working only in Window A; do not focus Window B.
10. After the DeepSeek generation should have completed, click **Refresh log** in Window A.

PASS means the summary shows non-zero:

```text
visible+unfocused entries after submit
unfocused final-answer growth events
```

or equivalent `.ds-markdown` / `.ds-message` growth, while `hasFocus=false`.

This would prove that a real DeepSeek page can keep rendering without stealing focus, preserving a path to Compact Assistant.

FAIL means the second-window DeepSeek page becomes `hidden`, fails to generate, or its answer DOM does not grow until that window gains focus. In that case, the DOM-only Compact Assistant path should be considered blocked and Chrome Split View becomes the practical fallback.

## Recorded separate-window result (2026-09-19)

Result: **PASS**.

Observed while DeepSeek was the selected tab in a second, non-minimized Chrome window and the user worked in another window:

- `visibilityState` remained `visible`;
- `document.hasFocus()` remained `false`;
- prompt submission succeeded from the other window;
- DeepSeek entered generation while still visible+unfocused;
- answer DOM started growing while the provider window still had no focus;
- `answerLength`, `.ds-markdown`, and `.ds-message` all grew continuously during generation;
- the answer reached a completed rendered state without focusing the DeepSeek window.

Conclusion: the Compact Assistant architecture remains viable if the real DeepSeek Web page is kept as the selected tab in a separate, non-minimized Chrome window. A fully hidden/background tab is not viable for DOM streaming, but a visible+unfocused provider window is.

## Fully-covered provider-window test

This test answers whether the DeepSeek provider window may sit completely behind the normal work window.

No code change is required; the existing telemetry already records `visibilityState`, `hasFocus`, generation, and answer growth.

1. Keep DeepSeek as the selected tab in Window B and leave Window B non-minimized.
2. Move/resize Window A so that it completely covers Window B.
3. Keep Window A focused and do not interact with Window B.
4. From Window A open **DeepSeek Hidden Tab Spike** and click **Refresh log**.
5. Required precondition for this arrangement to remain viable:
   - `current visibility: visible`
   - `current hasFocus: false`
6. If the precondition passes, click **Send probe** from Window A.
7. Keep Window B fully covered and unfocused through the whole generation.
8. Refresh the log again from Window A.

PASS:
- visibility stays `visible`;
- hasFocus stays `false`;
- generation starts;
- answer/.ds-markdown/.ds-message lengths grow while the provider window is fully covered.

FAIL:
- visibility becomes `hidden`;
- generation/answer DOM stalls until Window B is uncovered or focused.

This is intentionally empirical because browser/OS occlusion handling differs from ordinary Page Visibility semantics and can vary by platform.

### Recorded fully-covered result (2026-09-19)

Result: **PASS** on the tested Mac/Chrome setup.

After the DeepSeek provider window was completely covered by the work window:

- every post-submit sample remained `visibility=visible`;
- every post-submit sample remained `hasFocus=false`;
- no post-submit `focus`, `visibilitychange`, `freeze`, `pagehide`, or `resume` event occurred;
- generation started and remained active while the provider window was fully covered;
- answer DOM began growing from zero while still fully covered and unfocused;
- 183 answer-length growth events were observed after submission;
- the completed rendered answer reached length 9332.

Conclusion: on the tested setup, the DeepSeek provider window may be completely behind the normal work window. It must remain non-minimized and DeepSeek must remain that provider window's selected tab, but it does not need focus or any visible pixels on screen.

