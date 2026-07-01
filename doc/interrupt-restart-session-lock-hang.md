# Upstream bug report — interrupt/restart of an in-flight reply hangs holding the session lock

Draft for an openclaw core issue. Discovered while implementing the VK channel's
"combine a follow-up message that arrives mid-reply" behaviour, but the failure
is in **core reply-dispatch / embedded-runner restart handling**, not the channel.

## TL;DR

When a second message for the same session arrives **while the first reply is
still being generated** (`queueDepth >= 2`), core interrupts the first reply to
restart it with the combined context (the `interrupt` queue mode / foreground
reply fence). On the **claude-cli live backend**, the interrupted run then
**stalls while holding the session write-lock**: the second message stays
`queued_behind_active_work` forever and the session never progresses, surfacing
as a `stalled_agent_run` (`active_work_without_progress`, `recovery=none`) until
the 15-minute stuck-session abort fires.

Net effect: a user who sends a clarification/follow-up while the agent is still
answering the first message gets no reply to either for 15 minutes, and the whole
session lane is frozen.

## Environment

- openclaw **main** built from source (commit `98254634`, i.e. *after* the
  #96847 reply-session reentrancy fix — this is a **separate** bug).
- Backend: **claude-cli live** (`provider=claude-cli model=opus`).
- Channel: VK, `deliveryMode: "direct"`, single agent `main`. Channel-agnostic:
  any `direct` channel with `queue.mode: "interrupt"` reaches the same path.
- Queue mode `interrupt` (restart/combine on a mid-reply follow-up).

## Reproduction

1. Send message **A**.
2. While A is still being generated (before its reply is delivered), send
   message **B** in the same conversation.

Core queues B (`queueDepth=2`), decides to restart A's reply to fold in B, closes
A's claude-cli live session with `reason=restart` — and then A's embedded run
stalls holding the session lock, so B never runs.

## Evidence

```
19:45:45.480 claude live session start: provider=claude-cli model=opus activeSessions=1   ← A running
19:45:54.241 message queued: ... source=dispatch queueDepth=2 sessionState=processing      ← B arrives
19:46:04.320 claude live session turn: provider=claude-cli model=opus durationMs=18837 ...  ← A's turn RESOLVES
19:46:04.322 claude live session close: provider=claude-cli model=opus reason=restart       ← restart requested
19:49:00.465 long-running session: ... queueDepth=2 reason=queued_behind_active_work
             classification=long_running activeWorkKind=embedded_run lastProgress=cli_live:result
19:49:30.474 stalled session: ... reason=active_work_without_progress classification=stalled_agent_run
             activeWorkKind=embedded_run lastProgress=cli_live:result lastProgressAge=206s recovery=none
   (repeats every 30s; the run never completes and never releases the session lock)
```

Key detail: **A's turn resolves cleanly** (`durationMs=18837`, output produced).
The stall is *after* the turn, at the embedded-run level — A's run holds the
session write-lock and never completes, so B is `queued_behind_active_work`.

## Localization

The restart path (superseded reply):

1. `reply-run-registry.ts` `abortForRestart()` → `abortWithReason("restart", …)`
   → `getAttachedBackend(operation)?.cancel("restart")`. For a **running**
   operation it does *not* `clearState()` (only queued ops clear synchronously) —
   it relies on the run to unwind and release its resources.
2. The attached backend is the embedded run's `queueHandle`. `cancel` and `abort`
   both route to `abortActiveRunExternally` (`attempt.ts:3748-3749`), which calls
   `abortRun(false, createAgentRunRestartAbortError())` (`attempt.ts:3728-3732`).
3. `abortRun` aborts the controller and **releases the session lock** via
   `releaseEmbeddedAttemptSessionLockForAbort` → `releaseHeldLockForAbort()`
   (`attempt.ts:3426`).

So by static reading the lock *should* be released on restart. Empirically it is
**not** released when the restart coincides with the turn resolving — the run is
in the post-turn window (transitioning from "turn produced a result" to
"deliver/complete") and the abort does not unwind it, leaving the session
write-lock (`attempt.session-lock.ts`, the ~2k-line ownership/prompt-lock/write-lock
coordinator) held. This looks like a **race between turn-completion and the
restart-abort** on the claude-cli live backend.

## What we ruled out

- **Not** `closeLiveSession(session, "restart")` orphaning the pending turn: the
  turn resolves normally *before* the restart close (`currentTurn` is already
  `null`), so settling it there is a no-op. (We tried that fix; it does nothing.)
- **Not** the #96847 store-writer reentrancy bug: this build already has that fix,
  and the failure mode is a held session lock / `queued_behind_active_work`, not
  `reply session initialization conflicted`.

## Note for whoever writes a regression test

The existing embedded-runner test harnesses (`run.overflow-compaction.harness.ts`)
`vi.doMock("./run/attempt.js")` and stub `runAttempt`, so the real
`attempt.session-lock` / claude-live turn machinery — where this bug lives — is
not exercised. A faithful repro needs a higher-fidelity integration harness that
runs the real `attempt.js` with only the LLM mocked, plus deterministic control
to fire the restart-abort exactly in the post-turn-resolve window.

## Impact

- P1-class UX: the natural "let me add one more thing while it's thinking" flow
  hangs the session for 15 minutes on the claude-cli backend.
- Workaround in channels: serialize inbound per conversation (don't let a
  follow-up reach core until the current reply completes). That trades the
  interrupt/combine feature for reliability — see the VK plugin's inbound
  debouncer (`VK_INBOUND_DEBOUNCE_MS`, default serialize-only):
  https://github.com/Shagrat2/openclaw-vk.
