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

Status: **CLOSED / PASS in Google Chrome + Docker (2026-09-15).**

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

Automated status: `npm run check` covers extension, gateway, native host/runtime, Chrome framing, host allowlist, Docker argv policy, Secret Firewall, and process-level Native host framing. The integrated gate in `docs/p2-live-test.md` passed on the owner's Mac: all 11 live conditions passed, including stable one-shot workspace identity, read-only mutation denial, Secret Firewall redaction, no real container network connectivity, autonomous continuation, and no leftover P2 call containers.

## P3 — Real bounded coding loop

Status: **CLOSED / PASS in real macOS Google Chrome + Docker (2026-09-15).**

Connect `read/write/edit/bash` to the armed conversation. Keep autonomous execution within bounded iterations/calls. Do not default to per-tool approval unless real evidence requires it.

P3 browser-visible tools are exactly `open_workspace`, `read`, `write`, `edit`, and `bash`. The owner-selected `/workspace` bind becomes writable and non-recursive; the one-shot container, network-off policy, non-root UID:GID, `CapDrop=ALL`, `no-new-privileges`, fixed image/entrypoint, 30-second browser bash cap, path/symlink policy, Secret Firewall, replay protection, and loop bounds remain unchanged.

`write` and `edit` are structured mutation tools. Because `bash` runs inside the same writable workspace, it can also mutate project files; P3's security boundary is isolated workspace mutation, not exclusive mutation through `write/edit`. No Git credentials, automatic commit, or push capability are added.

Live acceptance is recorded in `docs/p3-live-test.md`. All 12 conditions passed in the owner's real Chrome + Docker environment: writable changes persisted across fresh one-shot containers, `edit` was observed by the next container, bounded `bash` verified and cleaned the fixture, path-escape write failed closed, the autonomous six-call loop completed without non-allowlisted tools, no call containers remained, Base stayed untouched, and no commit/push occurred.

## P4 — Coding E2E

Status: **CLOSED / PASS in the owner's real macOS Google Chrome + Docker environment (2026-09-15).** Evidence: `docs/p4-live-test.md`.

On a disposable test repository, DeepSeek Web autonomously:

- locates/opens the workspace;
- reads code;
- changes one bounded source location;
- runs tests;
- inspects diff;
- returns the final answer.

No DeepSeek API key, no extension-originated private completion call, and no local runtime network.

P4 required one runtime-image fix exposed by the first live run: Docker Desktop presents the bind mount point as root-owned while tools run as the host UID, so git refused the repository. `native/Dockerfile` now trusts exactly `safe.directory /workspace`.

Next: the separate Base/Plus DeepSeek cleanup is its own reviewed task. P5 packaging/distribution remains behind its policy/terms review gate.

## P5 — Packaging/distribution

Blocked on E2E success and current DeepSeek terms/policy review.

Only then add installer, diagnostics, uninstall and distribution packaging.
