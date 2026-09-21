# Assistant Side Panel — architecture review (no implementation)

Date: 2026-09-19
Reviewer scope: read-only. Repository state at review time: `a0059bc` plus uncommitted Browser WebMCP V1 work
(`extension/browser-client.js`, `extension/target-executor.js`, `extension/tool-contract.js`, `tests/sidepanel-spike/`).
`npm test` at review time: **135/135 PASS**.

---

## 0. Records gap to close first

`docs/browser-v1-live-test.md` still states:

```text
Real Chrome + normal DeepSeek Web acceptance: NOT YET RUN.
```

The task description says that run passed (inspect → fill → select → safe click → `CONFIRMATION_REQUIRED` on Submit).
The file is untracked, so the only record of that acceptance is the prompt. This is a records gap, not a doubt about the
result: update that doc with browser/version, ordered tool names, final field values and the `CONFIRMATION_REQUIRED`
evidence before building on top of it, otherwise the "proven component" claim has no artifact behind it.

---

## 1. Architecture verdict

**Conditionally sound — and the condition is one unanswered empirical question, not a design question.**

The proposed shape

```text
local Side Panel UI  ↔  real authenticated DeepSeek Web tab  ↔  existing DOM adapter / WebMCP loop  ↔  local + current-tab browser tools
```

is the *only* remaining shape once A and B fail, and both failures are now explained by authoritative Chrome behavior
rather than by bad luck:

* **B is not a bug, it is the documented contract.** `sidePanel` docs: the panel path "must be a local resource within
  the extension package". A Side Panel document cannot become a normal web page. B could never have passed.
* **A failed on DeepSeek's own challenge**, which is a site decision; the accepted constraint list (§8 of the task)
  forbids working around it. So the real DeepSeek page must stay in an ordinary top-level browsing context.

Given those two, "our own panel UI + real DeepSeek tab + existing loop" is minimal. There is no smaller architecture
that still shows the conversation next to the work page.

**But the proposal has one load-bearing assumption nobody has tested: that the DeepSeek page keeps producing answer DOM
while its tab is hidden.** If it does not, the mirror architecture is dead in its proposed form, and no amount of
extension code fixes it. That is Spike 0 below. Everything else in this review is subordinate to it.

### The non-obvious, cheap alternative (mention, do not adopt blindly)

Before building a mirror, spend two minutes on Chrome's **split view** (two tabs visible side by side in one window).
If it is available in your Chrome and you find it acceptable, it delivers "work page + DeepSeek without switching" with
**zero new code**, using the already-proven architecture, and neither page is ever hidden. It does *not* deliver the
stated product goal (compact assistant column, folded tool activity, provider selector), and I have not confirmed
availability in your build — so this is a sanity check on the requirement, not a recommendation. It has real diagnostic
value either way: it separates "DeepSeek unfocused" from "DeepSeek hidden" as variables.

---

## 2. Simplest recommended architecture

```text
Side Panel (extension page, visible while open)
  │  presentation + prompt input only; renders from structured events; no authority
  ├── long-lived port ──► background service worker  ◄── single authority layer (unchanged role)
  │                         │
  │                         ├── chrome.tabs.sendMessage ──► DeepSeek tab content script  (existing content.js)
  │                         │        • sendText() reused verbatim for user prompts
  │                         │        • answer observation reused; adds one partial-text event
  │                         │
  │                         ├── callNativeTool()   ──► existing Native Messaging runtime   (unchanged)
  │                         └── callBrowserTool()  ──► target-executor.js in the bound work tab (unchanged)
  │
  └── bound work tab W = the tab whose popup gesture opened this panel
```

Three decisions make this the minimum:

1. **The clock moves out of the hidden page.** The Side Panel is a visible extension document, so its timers are not
   throttled; messages it sends run real tasks in the hidden DeepSeek frame (message delivery is not timer-scheduled).
   The panel drives `tick()`-equivalent polling and send-confirmation retries. This is the fix for every *self-inflicted*
   throttling failure (Case 1 in §5).
2. **Background stays the only authority layer.** The panel never calls `chrome.scripting`, never resolves tabs, never
   decides what a tool may do. It sends `prompt` and receives events. This keeps the existing trust boundary
   ("page/model output is data, not permission") intact and keeps the panel out of the security-critical path.
3. **One bound session in V1.** Exactly one (work tab W ↔ DeepSeek tab D) pair is active at a time.

### Permission delta

Add exactly `"sidePanel"`. Nothing else:

* no `tabs` — `chrome.tabs.query({url:'https://chat.deepseek.com/*'})` already works under the existing
  `host_permissions`, and the bound work tab's URL/title come from the activeTab grant;
* no `<all_urls>`, no `declarativeNetRequest`, no optional host permissions;
* `activeTab` + `scripting` keep doing exactly what they do today.

### The gesture chain (this is the part that must not be "simplified")

```text
user clicks the extension action on work tab W
      → Chrome grants activeTab for W        (action invocation is a documented grant trigger)
      → popup.html opens (kept, it already owns Work / Attach / install controls)
      → user clicks "Control this page & open Assistant"
      → background attaches target W (existing attachActiveTarget path, extension/background.js:76)
      → chrome.sidePanel.open({ tabId: W })  (docs explicitly permit open() from a user action on an extension page)
```

One click, no new permission, and the existing fail-closed invalidation
(`extension/background.js:350-351`, `onUpdated → clearTargetForTab`) is untouched.

---

## 3. Reuse unchanged

| Component | Why it survives |
|---|---|
| `extension/core/agent-controller.js` | Pure, serializable, per-conversation authority. The UX change does not touch it. |
| `extension/tool-loop/tool-call-format.js`, `tool-contract.js` | Wire format and tool surface are unchanged. No second protocol. |
| `extension/native-client.js` + Native Messaging runtime | Untouched. Local tools work from the panel because the panel changes only who types the prompt. |
| `extension/target-executor.js` (all 413 lines) | Semantic refs, redaction, `CONFIRMATION_REQUIRED`, cross-origin fail-closed. Nothing in the UX change touches the executor contract. |
| `extension/browser-client.js` | Argument validation and `TARGET_NOT_ATTACHED` semantics unchanged. |
| `content.js` `sendText()` (lines 58-79) *as the single send path* | The panel's prompt and a tool result take the identical route into the DeepSeek composer. |
| `content.js` fold CSS (lines ~205-275) | Stays for the DeepSeek tab. The panel does **not** reuse it (see §4). |
| DeepSeek authenticated web session | Still the only model/governance layer. No API key, no cookie export, no private endpoint. |

---

## 4. Components that need modification

1. **`content.js` — remove the internal wait loops** (`await sleep(100)` at lines 67 and 75, deadlines at lines 16-17).
   These are our own timers inside a hidden frame; at 1 timer/minute they blow their 3 s / 5 s deadlines and return
   `SEND_DISABLED` / `SEND_NOT_CONFIRMED`. Change `sendText` to a single non-blocking attempt returning
   `SEND_PENDING_CONFIRMATION`, and let background/panel re-poll. Bounded change, same observable contract.
2. **`content.js` — stop depending on `setInterval(tick, POLL_MS)` (line 291) for stability.** Keep the
   `MutationObserver` (line 284, not throttled) and the interval as a fallback, but let the panel drive ticks while it
   is open, so `STABLE_MS` (line 185) is measured on a real clock.
3. **`content.js` — one new outbound event:** throttled partial answer text (~200 ms) so the panel can stream. ~5 lines
   on top of the text the tick already computes. Presentation only; it must not feed `acceptCompletion`.
4. **`background.js` — session binding replaces the single global target slot.** `TARGET_KEY` (line 10) is one global
   record: correct today (one gesture, one planner tab), **wrong under the panel model**, because a browser tool call
   arriving from DeepSeek tab D carries no indication of which work tab it meant. V1 must store one
   `{ deepseekTabId, workTabId, origin }` session and reject tool calls that arrive from any other DeepSeek tab.
   This is a V1 correctness requirement, not a later nicety.
5. **`popup.js` / `popup.html`** — add the one "Control this page & open Assistant" button described in §2.
6. **`manifest.json`** — add `"sidePanel"` and `"side_panel": { "default_path": "sidepanel.html" }`.
7. **New `sidepanel.html` / `sidepanel.js`** — small, and deliberately dumb:
   * renders from structured background events; every model-authored string goes in via `textContent`, never `innerHTML`;
   * reuses the 🔧 **vocabulary** (`🔧 inspect_form ✓`, `🔧 fill ✓`, `🔧 read ✓`) but **not** the CSS-fold hack — the hack
     exists only because DeepSeek's DOM is not ours; in the panel we already have structured data;
   * keeps no authority and no durable state of its own (the panel document can be destroyed at any time — see §7);
   * provider selector renders `DeepSeek` only. No provider abstraction, no ChatGPT stub logic.
8. **`content.js` `interceptSend` (lines ~96-122)** — becomes deletable *after* the panel path is proven, because the
   panel can append `buildWorkInstructions()` itself on the first message of a conversation. Do not delete it in the
   same step; it is still the path for users who type in the DeepSeek tab.

---

## 5. Likely failure modes

### Must solve in V1

| # | Failure | Status / fix |
|---|---|---|
| F1 | **DeepSeek page produces no answer DOM while hidden** (if its streaming render is `requestAnimationFrame`-gated, rAF does not run in hidden tabs). | **Unverified, and it gates the whole architecture.** Not fixable from the extension. Fallback: DeepSeek in a visible second window / split view. → Spike 0. |
| F2 | Our own timers in the hidden DeepSeek frame. Chrome: hidden-page timers run **once per second**, and **once per minute** after >5 min hidden when the timer chain count is ≥5 and the page is silent — `setInterval` iterations count toward that chain. So `POLL_MS=500`, `STABLE_MS=2000`, and the 3 s/5 s send deadlines all become wrong. | Fix = §4.1 + §4.2 (drive from the visible panel; no `sleep()` loops in the page). |
| F3 | **Ambiguous work-tab target** with a global `TARGET_KEY`. | Fix = §4.4 single bound session; panel shows `Controlling: <origin>`; a different active tab shows a banner, never silent retargeting. |
| F4 | Work tab navigates/reloads/closes → refs (`e1`, `e2`) stale. | Already correct: `onUpdated`/`onRemoved` clear the target (`background.js:345,350-351`) and the executor re-validates refs. Keep it; surface it in the panel as "control lost, click to re-control". |
| F5 | DeepSeek tab **discarded** (Memory Saver) → content script gone, page reloads on revisit. | Detect `tab.discarded` before driving the loop; panel says "DeepSeek session needs reload". Document the user-side mitigation: keep `chat.deepseek.com` in Chrome's "Always keep these sites active", verify at `chrome://discards`. |
| F6 | DeepSeek session/challenge expiry mid-loop. | Fail closed and tell the user in the panel to open the DeepSeek tab and log in. Never automate a challenge. |
| F7 | Panel closed/reopened mid-task, or panel document destroyed on tab switch. | All state stays in `chrome.storage.session` + background (already the pattern for Work authority). The panel rebuilds from a `state` event on connect. |
| F8 | Model-authored text rendered in a trusted extension page. | `textContent` only; no `innerHTML`; no link auto-activation; panel CSP stays `script-src 'self'`. |

### Can wait

* Multiple simultaneous assistant sessions / multiple work tabs (V1 = one bound session, explicit rebind).
* Multiple DeepSeek conversations in parallel (existing per-conversation pending/`awaiting` logic already isolates them).
* **Tab freezing.** Requires Energy Saver active **and** hidden+silent >5 min **and** "CPU-intensive". An idle DeepSeek
  tab is not eligible; treat as an observed-only risk for V1.
* MV3 service-worker suspension: an open panel port keeps the worker alive while the panel is open, and the existing
  session-storage reconstruction already covers the rest.
* ChatGPT as a second provider. Nothing in this design should be generalized for it now.

---

## 6. Chrome/browser assumptions already proven

1. Side Panel cannot host a web URL top-level — documented (`sidePanel` docs: local package resource only). Explains B.
2. DeepSeek Web in an extension-origin iframe fails its own challenge — measured (Experiment A).
3. `sidePanel.open()` is allowed in response to a user action, including a user interaction on an extension page — documented.
4. `activeTab` is granted by action invocation, context menu, `commands` keyboard shortcut, or omnibox acceptance —
   **and not by a click inside an extension page**. It survives same-origin navigation and is revoked on cross-origin
   navigation / tab close — documented.
5. Hidden-page timer throttling: 1/s, then 1/min under intensive throttling (>5 min hidden, chain ≥5, silent ≥30 s,
   no WebRTC) — documented.
6. Freezing eligibility (Energy Saver + hidden/silent >5 min + CPU-intensive) and the exemption list — documented.
7. The existing loop works when the DeepSeek tab is **focused**: P1–P4 live PASS, plus the Browser WebMCP V1 run
   (subject to §0).
8. Automated suite green at 135/135 with the uncommitted browser work in place.

## 7. Assumptions still needing empirical verification

| V# | Question | How |
|---|---|---|
| V1 | Does the DeepSeek answer DOM grow **while the tab is hidden**? | Spike 0 (timestamped mutation log). **Gating.** |
| V2 | Does `MutationObserver` in the hidden frame keep firing across the 5-minute intensive-throttling boundary? | Same log as V1. |
| V3 | Does a message-driven `sendText` actually write the composer and click Send in a hidden tab (React state updates while hidden)? | Spike 2. |
| V4 | Is the Side Panel document destroyed/reloaded on tab switch, and does it survive switching to a tab where the panel is disabled? | Spike 3; docs are silent. |
| V5 | Does the action click that opens the popup still grant `activeTab` when the popup then calls `sidePanel.open()`? | Spike 3 (attach must still succeed). |
| V6 | `openPanelOnActionClick` vs an action `default_popup` — which wins? | Only if you abandon the popup path; not needed for the recommendation. |
| V7 | Is a visible-but-unfocused tab in another window exempt from discarding? | `chrome://discards`, only if Spike 0 forces the second-window fallback. |
| V8 | Does Chrome split view exist in your build, and does it satisfy you? | 2-minute manual check (§1). |

---

## 8. Minimal spike plan, in execution order

Each spike changes one variable. Spikes 0–2 need **no** Side Panel code at all — they use today's extension.

**Spike 0 — does a hidden DeepSeek tab still render? (GATE, ~15 min)**
In `content.js`, temporarily append `Date.now()` plus `document.visibilityState` and the current answer length to
`chrome.storage.session` on every `MutationObserver` fire. Send a prompt that produces a long answer, switch to another
tab immediately, wait 6+ minutes (past intensive throttling and freeze eligibility), come back, dump the log.
*Pass* = timestamps and growing answer length **while `hidden`**. *Fail* = mutations stop at hide and resume at show →
the mirror architecture is dead as proposed; go to the visible-second-window / split-view fallback before writing any
panel code. Do not judge this by "the answer was there when I looked".

**Spike 1 — one full tool loop with the DeepSeek tab hidden (~20 min)**
Existing extension, Work on, one local-file tool call, DeepSeek tab hidden the whole time. Expect the *send* step to
fail (that is F2, predicted). Record which code returned which error. This measures the real gap §4.1 must close.

**Spike 2 — externally driven send (~30 min)**
Minimal patch: `sendText` does one attempt, background re-polls confirmation. Repeat Spike 1. Pass = one complete
tool turn with the DeepSeek tab hidden for >5 minutes. **This is the real architecture proof.** If Spikes 0–2 pass, the
rest is UI work.

**Spike 3 — panel shell + gesture chain (~30 min)**
`sidepanel.html` with a text box and a transcript list; popup button attaches the target and calls `sidePanel.open()`.
Prove: activeTab grant still works (V5), one prompt from the panel reaches DeepSeek, the reply streams back into the
panel, and the panel survives a tab switch and reconnects (V4).

**Spike 4 — bound session + one browser tool (~30 min)**
Panel on work tab W, DeepSeek hidden. `inspect_form` then one `fill`, visible live in W without switching tabs.
Also check: a second work tab with its own panel must **not** silently steal the target (F3).

**Spike 5 — mixed tools in one conversation (~20 min)**
One DeepSeek conversation: one local `read`, then one browser `fill`. Confirms the single tool contract still covers
both surfaces from the panel.

Stop between spikes. Spikes 3-5 are worthless until 0 and 2 pass.

---

## 9. Blockers that would invalidate the approach

* **B0 (real):** Spike 0 fails → no DOM growth while hidden. The panel mirror cannot exist over a hidden tab; the only
  paths left are a visible second window / split view (acceptable, changes the UX) or DeepSeek network observation
  (explicitly rejected in `CONTEXT.md` §6 and §3 — do not quietly revisit it).
* **B1:** Spike 2 fails → the composer cannot be written or Send cannot be clicked in a hidden tab even when driven
  externally. Same fallback as B0.
* **B2:** Chrome discards the DeepSeek tab aggressively enough that sessions break constantly → V1 needs the
  "Always keep these sites active" instruction as a documented prerequisite, not an optimization.
* **B3 (process, not technical):** the §0 records gap. Do not build a second feature on an acceptance that exists only
  in a chat message.

Not blockers: `sidePanel` permission, popup coexistence, service-worker lifetime, ref invalidation — all have known,
small answers above.

---

## 10. Is there enough evidence to start implementing after the spikes?

**Conditional yes, and the condition is Spike 0.**

* Spike 0 **and** Spike 2 pass → yes. The architecture is then proven end-to-end in the only configuration that matters
  (DeepSeek hidden, loop completing), and Spikes 3-5 are ordinary UI/binding work over unchanged proven components.
* Spike 0 passes, Spike 2 fails → stop. Re-decide hosting before any panel code.
* Spike 0 fails → **no.** The proposed architecture is not implementable as written; the decision to re-take is
  "visible second window / split view vs. abandoning the panel UX", not "how do we code the mirror".

Also required before implementation, independent of the spikes: close §0, and accept §4.4 (single bound session) as a
V1 requirement rather than a follow-up.

---

## Things that must NOT be added yet

Playwright / Selenium / automation servers · screenshots / OCR / vision clicking · a generic provider framework or
provider plugin registry · ChatGPT code paths (a disabled menu label is the maximum) · a new local daemon or persistence
database · a generic JS browser tool · CSS-selector/XPath/tab-id authority for the model · `declarativeNetRequest`,
CSP/XFO rewriting, challenge workarounds, cookie/token export, private completion endpoints · `<all_urls>` or `tabs`
permissions · a second agent/tool protocol for the panel · per-tool manual approval UI (the gate is Work + the
executor's fail-closed rules) · multi-session orchestration.
