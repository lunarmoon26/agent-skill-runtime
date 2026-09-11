# Lifecycle lessons from MiniCordis

This note records design lessons from the [MiniCordis series](https://www.bange.life/tech/mini-cordis-course-from-zero) and [source at commit 2c90365](https://github.com/sleepworm/mini-cordis/blob/2c90365bafe5cdbe36bc51d25ed59ddb5521baf5/src/context.ts). It distinguishes the change in this PR from possible follow-ups.

## Applied: diagnostic failure isolation

MiniCordis centralizes cleanup and attempts to continue after individual cleanup failures. The transferable principle is that auxiliary failures must not obscure the primary operation. Our diagnostic observer follows that rule for both execution and preparation; the authoritative behavior is in [the contract](contract.md#diagnostic-observers). Approval remains part of execution policy, not observation.

## Existing ownership boundary

The executor manages each invocation's subprocess, timeout, abort listener, and bounded output. Host harnesses own plugin registration, sessions, and service dependencies. The DeepSeek adapter relies on host-owned registration effects and forwards the invocation signal. Unregistering a tool and cancelling its active work are separate lifecycle concerns.

The CLI executes directly through the shared core. These lessons do not require an MCP server or an always-visible tool catalog.

## Proposed follow-ups, not implemented

- Consider an internal asynchronous cleanup scope when it simplifies concrete resource-acquisition and failure paths. Preserve reverse-order cleanup and attempt remaining cleanup after one failure.
- Establish host shutdown guarantees before adding runtime-wide close/cancellation. The runtime currently has no active-invocation registry or public close method.
- If shutdown ownership is added, specify rejection of new calls, cancellation of active calls, and waiting for process cleanup. Test concurrent invocations and repeated close.
- Keep reactive service injection and context trees in the host. Explicit engine diagnosis and dependency preparation remain appropriate for the CLI.

Resource cleanup is not transactional rollback of files, network effects, or persistent dependency caches.

## Limits of the reference implementation

MiniCordis is an educational synchronous runtime. Its mutable current-scope pointer is not an asynchronous invocation-ownership mechanism. Its error reporter invokes event listeners directly, so a throwing error listener can interrupt cleanup despite the intended failure isolation. Child service lookup inherits from parents, but parent mutations do not reevaluate child injections. Service provision needs an explicit cleanup effect to be reversible.

Borrow the ownership invariants and focused lifecycle tests rather than copying the Context implementation or introducing a second plugin framework.
