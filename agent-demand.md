# Agent demand / implementation gate

Before adding production code, answer all four questions:

1. Which current phase acceptance criterion requires this code?
2. Is there a demonstrated failure or missing required capability?
3. Can an existing proven mechanism satisfy it with less code?
4. Can anything be deleted instead?

A new mechanism normally requires one of:

- a demonstrated correctness/runtime blocker;
- a concrete security failure mode;
- a required user capability;
- an authoritative platform requirement.

Speculative extensibility is not sufficient.

## Current gate

Current phase: **P1 browser-loop proof**.

Allowed production scope:

- Chrome extension limited to `https://chat.deepseek.com/*`;
- strict textual tool-call format/parser;
- ARMED/disarmed state;
- completed-message observation experiment;
- deduplication and marker neutralization;
- fake tool-result continuation through the normal DeepSeek UI;
- tests/harnesses needed to prove those behaviors.

Explicitly disallowed until P1 passes:

- Native Messaging host;
- Docker/local runtime;
- filesystem access;
- terminal execution;
- installer/daemon;
- DeepSeek private request client;
- provider abstraction;
- multi-host support.
