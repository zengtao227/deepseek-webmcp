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

**P1, P2, and P3 are CLOSED / PASS in Google Chrome.** P1 proved the browser continuation loop; P2 proved one-shot Native Messaging + the isolated read-only Docker runtime; P3 proved the real writable bounded coding loop in macOS Chrome + Docker.

The repository is now in **P4: coding E2E on a disposable test repository**.

The architecture remains:

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

P3 exposes exactly `open_workspace`, `read`, `write`, `edit`, and `bash`. The owner-selected workspace is mounted **writable** so mutations persist, while the container remains network-disabled, non-root, capability-dropped, no-new-privileges, and fresh per tool call via `docker run --rm`. The bind mount does not recursively include nested mounts.

`bash` can also mutate files inside the selected workspace; `write`/`edit` are structured bounded mutation tools, not a claim that they are the only mutation path. Git credentials/publication are not exposed and the product does not auto-commit or push.

P3 automated checks are part of `npm run check`; its successful real Chrome + Docker acceptance is recorded in `docs/p3-live-test.md`.

See `CONTEXT.md` for the product boundary and `docs/development-roadmap.md` for phase gates.
