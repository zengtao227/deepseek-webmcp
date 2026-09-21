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
browser-client.js             identical in both projects
        v
target-executor.js            identical in both projects  (inspect_page / inspect_form / fill / select / click)
```

## Rules

- `extension/browser-client.js` and `extension/target-executor.js` are **byte-identical** to the ChatGPT Embedded Panel copies. `extension/target-binding.js` differs only in the one origin it refuses to attach (the provider's own site).
- `tests/shared-core.test.js` pins them and, when `../chatgpt-embedded-panel` is present, compares against it. If it fails, the shared code was changed on one side: change both projects, then update the pins. Do not fork the behavior.
- `extension/browser-task.js` holds the page-lock and click-handoff logic with no provider names in it. The only input that differs is `activeTab` (the page in front of the owner). The ChatGPT project has the same logic inline in `service-worker.js`; a later shared package moves this file and points both projects at it.
- The DeepSeek-only parts stay outside the core: `content.js`, the provider window and session in `background.js`, `sidepanel.*`, answer rendering, and the local coding tools (native runtime).

## Owner rules baked into the core

- The assistant may open, read, fill and select. Submit, send, pay, delete and other commit-like clicks fail closed with `CONFIRMATION_REQUIRED`; the owner presses them.
- A click may hand the task to the page it opens, only within a short lease and only when Chrome reports the clicked page as the opener. A cross-origin move the owner did not cause pauses the task.

## Naming

"Embedded Panel" describes how ChatGPT is shown (embedded). DeepSeek cannot be embedded (its iframe fails its own challenge), so it is a *Compact Assistant* with a managed provider window. Names are chosen per provider shell; the core is Browser WebMCP. Rename only when the projects are merged.
