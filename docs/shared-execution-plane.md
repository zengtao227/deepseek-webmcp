# Shared Browser Execution Plane — what is shared, what is DeepSeek-only

Umbrella roadmap: `chatgpt-embedded-panel/docs/browser-webmcp-platform-roadmap.md` (Browser WebMCP). This project is one model-provider shell around a core that ChatGPT, DeepSeek and later local models all use.

```text
provider shell (differs)      DeepSeek: content.js reads/types in chat.deepseek.com, provider window, Side Panel mirror
        |                     ChatGPT: chatgpt.com embedded in the Side Panel (iframe + header policy)
        v
task target / handoff state   extension/browser-task.js   (+ extension/target-binding.js)
        v
runBrowserTool()              extension/browser-task.js
        v
frame routing                 tab lock stays top-level; accessible child frames are discovered by Chrome
        v
browser-client.js             identical in both projects; aggregates frames and routes namespaced refs
        v
target-executor.js            identical in both projects; one executor per accessible frame
                              (inspect_page / inspect_form / fill / select / click / scroll / keyboard)
```

## Rules

- `extension/browser-client.js` and `extension/target-executor.js` are **byte-identical** to the ChatGPT Embedded Panel copies. `extension/target-binding.js` differs only in the one origin it refuses to attach (the provider's own site).
- `tests/shared-core.test.js` pins them and, when `../chatgpt-embedded-panel` is present, compares against it. If it fails, the shared code was changed on one side: change both projects, then update the pins. Do not fork the behavior.
- `extension/browser-task.js` holds the page-lock and click-handoff logic with no provider names in it. The only input that differs is `activeTab` (the page in front of the owner). The ChatGPT project has the same logic inline in `service-worker.js`; a later shared package moves this file and points both projects at it.
- A task is still locked to one **tab**, not to a model-selected frame. Chrome's own `frameId` values are discovered when the executor is injected with `allFrames: true`. Inspection aggregates accessible frame-local results; child-frame element refs are exposed as `f<frameId>:eN`, and later actions can reach that frame only by using a ref that inspection actually returned.
- Cross-origin iframe support does not weaken Same-Origin Policy: no top-frame script reaches through another origin's DOM. Instead, the extension runs the same bounded executor inside each frame for which Chrome grants extension access. Unavailable frames are reported/denied and never cause fallback to a different frame.
- Provider identity remains separate from browser-page execution. DeepSeek/ChatGPT conversation routing may still require a top-frame sender; supporting page iframes does not let child frames speak for a provider session.
- The DeepSeek-only parts stay outside the core: `content.js`, the provider window and session in `background.js`, `sidepanel.*`, answer rendering, and the local coding tools (native runtime).

## Owner rules baked into the core

- The assistant may open, read, fill and select. Submit, send, pay, delete and other commit-like clicks fail closed with `CONFIRMATION_REQUIRED`; the owner presses them.
- A click may hand the task to the page it opens, only within a short lease and only when Chrome reports the clicked page as the opener. A cross-origin move the owner did not cause pauses the task.

## Naming

"Embedded Panel" describes how ChatGPT is shown (embedded). DeepSeek cannot be embedded (its iframe fails its own challenge), so it is a *Compact Assistant* with a managed provider window. Names are chosen per provider shell; the core is Browser WebMCP. Rename only when the projects are merged.
