# Web Provider Mode

Status: owner research (branch `feat/web-provider-chatgpt`, 2026-09-25). ChatGPT adapter loop verified on the live page; real-runtime run pending.

## Governing architecture: WebMCP Unified Side Panel

**One extension, one Side Panel, many Provider Adapters, several Connection Modes, one shared WebMCP capability/runtime layer.**

```text
WebMCP Side Panel
Provider:  ChatGPT | DeepSeek | Claude | Local Model | other AI
Mode:      MCP Mode | Web Provider Mode | Local/API Mode
Workspace: current mounted folders
Access:    Normal | High Trust
```

Browser Control, Local Workspace, Multi-Mount, High Trust and Remote Host Access are shared and never re-implemented per provider. Code may stay in separate repositories for now, but every new piece is designed against this shape so merging later needs no rework. Today's ChatGPT Side Panel and DeepSeek Side Panel are two early adapter implementations of it.

## Goal

Use any AI web page the user is already logged into as the model Provider for local WebMCP — no MCP, no Secure MCP Tunnel, no API key. The account tier (Free / Go / Plus / Pro) is irrelevant to the architecture: a provider only needs a working web UI that the adapter can drive for input, output and the tool loop.

```text
Web Provider Mode
├─ DeepSeek Web Adapter   (content.js — the first, mature adapter)
├─ ChatGPT Web Adapter    (content-chatgpt.js — revives the original ChatGPT Web fallback)
├─ Claude / Gemini / other web AI (future, same shape)
└─ Local model            (future: same loop, a local web UI or local API instead of a page)
```

MCP Mode (ChatGPT → Secure MCP Tunnel → WebMCP runtime) stays as it is.

## Shape

Everything below the page is shared and unchanged: the text tool-call format (`tool-loop/tool-call-format.js`), the loop controller (`core/agent-controller.js`), the Native Messaging link to the local runtime, Browser tools, ARM gating and High Trust.

A provider is:

1. one entry in `PROVIDERS` in `background.js` (origin + conversation path);
2. one ISOLATED content script that speaks the existing worker protocol (`work.arrive`, `work.completion`, `work.generating`, `work.continuation-result`, `assistant.health`, `assistant.prompt`, `assistant.snapshot`).

The Side Panel's Settings chooses the provider (`provider.id`); it applies to the next provider window.

The ChatGPT adapter is `content.js` with only the page layer replaced. It handles both live ChatGPT UIs: the textarea composer with `form button[type=submit][aria-label^="Send"]`, `button[aria-label^="Stop"]`, `li[data-message-role]` turns and `/uc/<id>` paths; and the older ProseMirror composer (synthetic paste, execCommand fallback) with `data-testid` send/stop buttons, `[data-message-author-role]` turns and `/c/<id>` paths. Regenerate/Share are left to ChatGPT's own controls.

## Evidence (2026-09-25)

Headless Chrome on the real chatgpt.com page (logged out — no account at all), the unmodified `content-chatgpt.js` injected, the worker simulated with the real `buildWorkInstructions()` text and a real-format tool result:

1. `assistant.prompt` → instructions attached → `SEND_CLICKED`;
2. ChatGPT replied with exactly `<webmcp_tool_call>{"id":"a1b2c","name":"open_workspace",…}</webmcp_tool_call>`, reported as `work.completion`;
3. the tool result was typed and sent (`work.continuation-result` `SEND_CLICKED`);
4. ChatGPT continued: "/workspace contains: notes.md, budget.xlsx, trip-plan.txt — trip-plan.txt looks like the travel plan".

Findings folded into the adapter: the live UI is a textarea composer with `li[data-message-role]` turns and `/uc/<id>` paths (the older ProseMirror/`data-testid` UI is kept as a fallback); ChatGPT first refused because it read the instructions as its own built-in tools, fixed by one ChatGPT-only framing line saying the extension runs them. The local runtime itself was simulated here.

## ChatGPT inside the Side Panel (2026-09-25)

ChatGPT mode reuses the proven ChatGPT Embedded Panel page as-is (`sidepanel-chatgpt.*`, `frame-policy.js`, `embedded-chatgpt.js`): chatgpt.com in the panel, Connecting → Ready, one automatic retry, then Retry / Open ChatGPT window, last conversation restored, Stop for a locked page. Added only: the Provider picker, Work **on by default** for the embedded ChatGPT (and its companion window), and the Web Provider loop (`content-chatgpt.js`) inside that frame. No provider window is opened. Left out: the model display, whose MAIN-world fetch probe conflicts with this repository's no-page-hook rule. Permissions (folders, High Trust) stay in the WebMCP App in the menu bar, not in the panel.

## POC acceptance (real runtime)

In a separate Chrome profile logged into a ChatGPT Free account (the extension keeps the DeepSeek WebMCP key, so the installed native host accepts it; the default profile is untouched):

1. Settings → Web Provider → ChatGPT; start Work.
2. One read-only tool round trip (list/read in `/workspace`), and ChatGPT continues with the result.
3. One ordinary task (e.g. summarise a file) — same kind of work as the Plus/MCP path. Answer quality is not judged.

## Next: one Side Panel for every mode and provider (design only)

Target: a single extension and Side Panel where the owner picks **Provider** (ChatGPT, DeepSeek, Claude, local model…) and **Mode** (MCP or Web Provider), instead of one extension per product.

- **Shared layer** (already shared in practice): local runtime via Native Messaging, Browser tools (`browser-client.js` / `target-executor.js` are byte-identical copies in the ChatGPT panel and DeepSeek today), approvals and High Trust.
- **Provider surface:** embedded in the panel when the site allows it (ChatGPT: works by relaxing chatgpt.com frame headers for the panel frame, as the Embedded Panel does); otherwise a provider window (DeepSeek: embedding failed, keep a strip visible).
- **ChatGPT MCP Mode** = today's Embedded Panel inside the same panel (tools arrive over the Tunnel; the panel only hosts the page). **ChatGPT Web Provider Mode** = the same embedded page plus `content-chatgpt.js` driving the text tool loop.
- **Local model:** the same tool loop against a local UI or local OpenAI-compatible API; no page needed.
- **Consolidation cost to plan for:** today there are three extension IDs and native hosts (`com.deepseek.webmcp.native`, `com.webmcp.browser`, `com.prism.webmcp.native`). One panel means one extension ID and one native host, plus a migration step in WebMCP Setup for existing installs. Suggested base: this extension (most mature loop), absorbing the Embedded Panel's frame hosting.
