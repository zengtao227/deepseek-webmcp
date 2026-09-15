# DeepSeek WebMCP

DeepSeek WebMCP is an experimental local coding bridge for the **free, logged-in DeepSeek Web UI** at `https://chat.deepseek.com`.

The goal is to let DeepSeek Web act as the model/governance layer while a separately constrained local runtime provides bounded local coding tools.

## What this is not

- not a DeepSeek API client;
- not DeepSeek Harness;
- not an unofficial DeepSeek API proxy;
- not a generic browser-automation framework;
- not a server-side multi-account service.

## Current phase

**P1 is CLOSED / PASS in Google Chrome.** The browser loop was proven live across three autonomous fake-tool turns, including fail-closed negative controls.

The repository is now in **P2: Native Messaging + minimal isolated local runtime**.

P2 keeps the proven DeepSeek browser loop and replaces the fake executor with:

```text
DeepSeek assistant output
  → strict WebMCP tool call
  → Chrome extension
  → one-shot Chrome Native Messaging host
  → fresh isolated Docker runtime
  → bounded real tool result
  → Secret Firewall
  → normal DeepSeek compose/send
```

P2 exposes only `open_workspace`, `read`, and `bash`. The workspace is mounted **read-only**, the container has **network disabled**, and each tool call runs in a fresh `docker run --rm` container. `write` and `edit` remain blocked until P3.

Automated P2 checks are part of `npm run check`. Real P2 closure still requires the macOS Chrome + Docker live gate in `docs/p2-live-test.md`.

See `CONTEXT.md` for the product boundary and `docs/development-roadmap.md` for phase gates.
