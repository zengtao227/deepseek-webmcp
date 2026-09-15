# Development roadmap

The roadmap is phase-gated. A later phase is not authorization to implement it before the previous gate passes.

## P0 — Project definition

Status: in progress.

Deliver:

- independent Git repository identity;
- `AGENTS.md`, `CONTEXT.md`, `README.md`, `SECURITY.md`, threat model and demand gate;
- migration/provenance manifest naming WebMCP Base `73249af` as the only canonical source;
- no local execution code.

Acceptance: documents agree on the no-API/no-Harness product boundary and on P1 as the next blocker.

## P1 — DeepSeek Web browser-loop proof

Status: **CLOSED / PASS in Google Chrome (2026-09-15).**

Implement only the smallest Chrome extension required to prove the web loop.

1. Reuse/adapt the strict textual tool-call parser from Base.
2. Compare DOM assistant-output observation with passive existing-stream observation using the same adversarial fixtures.
3. Retain only one observation mechanism. (Decided: DOM only. The comparison was resolved by measuring the live transport — the stream observer never saw XHR completions — not by scoring both mechanisms on fixtures; see `docs/p1-browser-findings.md` Finding 8.)
4. Add explicit ARMED state scoped to the active tab/conversation; context loss disarms.
5. Add deduplication, marker neutralization and bounded loop/call limits.
6. Use a fake tool executor only.
7. Insert fake results into the normal DeepSeek compose UI and use normal Send.

Gate on a real logged-in DeepSeek session:

- extension loads only on the intended DeepSeek origin;
- strict fenced tool calls survive observation and parsing;
- malformed/unfenced escape-heavy calls fail closed;
- DISARMED ignores valid calls;
- refresh/re-render does not replay calls;
- route change DISARMs;
- fake result continuation succeeds for three consecutive automatic tool turns;
- fenced escape fidelity succeeds;
- no extension-originated private DeepSeek completion request or credential extraction.

Acceptance evidence is recorded in `docs/p1-browser-findings.md`. Chrome is the baseline supported browser; Comet compatibility is optional and does not reopen P1.

## P2 — Native Messaging + minimal isolated local runtime

Status: **implemented locally; automated checks PASS; real macOS Chrome + Docker live gate pending.**

The design review completed with changes and the adopted architecture is one-shot `sendNativeMessage` + one fresh `docker run --rm` per tool call. See `docs/p2-review-brief.md` and `docs/p2-live-test.md`.

Intended scope only:

- Native Messaging transport bound to the expected extension identity;
- minimal host relay with fixed executable/container/entrypoint policy;
- isolated local five-tool runtime;
- V1 container network off;
- path/symlink safety and Secret Firewall;
- response sizing based on Chrome framing plus measured DeepSeek UI limits;
- command timeout materially below the normal five-minute browser-worker boundary.

Initial proof: `open_workspace`, harmless `read`, and `bash echo` only. P2 mounts `/workspace` read-only, permits exactly one tool call per assistant turn, caps browser-originated bash at 30 seconds, and exposes only `open_workspace`, `read`, and `bash` at the host boundary.

Automated status: `npm run check` covers extension, gateway, native host/runtime, Chrome framing, host allowlist, Docker argv policy, Secret Firewall, and process-level Native host framing. P2 is not CLOSED until the integrated live gate in `docs/p2-live-test.md` passes on the owner's Mac.

## P3 — Real bounded coding loop

Blocked on P2.

Connect `read/write/edit/bash` to the armed conversation. Keep autonomous execution within bounded iterations/calls. Do not default to per-tool approval unless real evidence requires it.

## P4 — Coding E2E

On a disposable test repository, DeepSeek Web autonomously:

- locates/opens the workspace;
- reads code;
- changes one bounded source location;
- runs tests;
- inspects diff;
- returns the final answer.

No DeepSeek API key, no extension-originated private completion call, and no local runtime network.

Only after P4 succeeds should the separate Base/Plus DeepSeek cleanup be executed.

## P5 — Packaging/distribution

Blocked on E2E success and current DeepSeek terms/policy review.

Only then add installer, diagnostics, uninstall and distribution packaging.
