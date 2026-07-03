# Upstream bug report — a mid-reply follow-up hangs holding the session lock

> **STATUS: RESOLVED — read [part 6](#update-2026-07-03-part-6--resolved-exact-root-cause--fix) first.**
> This document is an investigation log; earlier sections chase hypotheses that
> were later refuted. The confirmed root is a **transcript-mirror completion
> deadlock** in `dispatch-from-config.ts` (`mirrorTranscriptAfterDispatcherDelivery`
> awaits `dispatcher.waitForIdle()` before the reply operation completes; with a
> queued follow-up neither can proceed). The "interrupt/restart" framing in the
> early parts was the initial mental model — the op is not interrupted, it
> completes generation and then wedges in the delivery/mirror step. Fix:
> fire-and-forget the mirror. Distinct from #98416 (reply-session-init conflict)
> and a different root than #96703 (context-engine turn-maintenance).

Discovered while implementing the VK channel's "combine a follow-up message that
arrives mid-reply" behaviour, but the failure is in **core reply-dispatch**, not
the channel.

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

## Instrumented findings (added after live diagnostics)

We rebuilt core with targeted `console`/`log.warn` probes on the abort/lock-release
path and reproduced the hang live. Result:

- **The abort path is never invoked on restart.** `abortActiveRunExternally`,
  `abortRun`, and `releaseEmbeddedAttemptSessionLockForAbort` /
  `releaseHeldLockForAbort` (attempt.ts ~3400/3728/3426, attempt-abort.ts) all
  logged **zero** hits. So the interrupted run is *not* being aborted — it runs
  to the point of producing `cli_live:result`, then the run **completes-but-hangs
  before the normal lock-release path** (attempt.ts ~4920 `waitForSessionEvents`
  / `releaseForPrompt` → `attempt.session-lock.ts:releaseHeldLockWithFence`),
  which also logged zero hits. The hang is in the narrow post-turn region between
  the prompt resolving and `releaseForPrompt`, on the claude-cli live backend,
  while a follow-up is queued (`queueDepth=2`).
- The `reason=restart` live-session close is the run-end cleanup
  (`cleanupCliLiveSessionOnRunEnd` → `closeClaudeLiveSessionForContext`,
  cli-runner.ts:481) — **not** a reply-op abort. So "restart" here is a close
  reason, not evidence the run was aborted.

Net: the run holds the session write-lock, finishes its turn, and stalls before
releasing it when a follow-up is queued — without ever entering the abort path.

## Note for whoever writes a regression test

The existing embedded-runner test harnesses (`run.overflow-compaction.harness.ts`)
`vi.doMock("./run/attempt.js")` and stub `runAttempt`, **plus ~25 other
`vi.doMock`s** (model runtime, `cli-backends`, `workspace-run`, context-engine,
MCP, auth, usage, …). So the real `attempt.session-lock` / claude-live turn
machinery — where this bug lives — is not exercised by any existing harness.

A faithful repro therefore needs a new higher-fidelity integration harness that
runs the **real** `attempt.js` + session lock with only the CLI backend mocked at
the supervisor seam (`cli-runner.test-support.ts` `supervisorSpawnMock` /
`createManagedRun` gives the streaming-JSONL pattern), a real temp session
file/workspace, `runEmbeddedAgent` driven with a second message queued via
`queueEmbeddedAgentMessageWithOutcome` mid-turn, and deterministic control of when
the mocked turn resolves relative to the queued follow-up. That is substantial
new test infrastructure for a subsystem currently covered only via high-level
mocks — best built by maintainers who own it.

## Impact

- P1-class UX: the natural "let me add one more thing while it's thinking" flow
  hangs the session for 15 minutes on the claude-cli backend.
- Workaround in channels: serialize inbound per conversation (don't let a
  follow-up reach core until the current reply completes). That trades the
  interrupt/combine feature for reliability — see the VK plugin's inbound
  debouncer (`VK_INBOUND_DEBOUNCE_MS`, default serialize-only):
  https://github.com/Shagrat2/openclaw-vk.

## Update (2026-07-02) — run-loop harness + honest reassessment

A source-level run-loop harness was built (vitest, runs the *real*
`runEmbeddedAttempt` on mocked deps via
`mockedRunEmbeddedAttempt.mockImplementation(realAttempt)` + a controllable
`streamSimple` + `createAssistantMessageEventStream`; run with
`--disableConsoleIntercept`). It drove three concurrent scenarios — restart
mid-stream, steer mid-stream, restart+immediate-resubmit — on a non-CLI
(`anthropic-messages`) backend.

**Result: all three release the session lock and complete cleanly.** So the
generic run-loop and reply-operation layers do **not** deadlock on a concurrent
2nd message. The hang is specific to the **claude-cli live backend**.

Candidate root cause (real in pristine upstream, *not yet confirmed live*):
`closeLiveSession` in `src/agents/cli-runner/claude-live-session.ts` — the
`session.closing` reentrancy guard can swallow the settling of a still-pending
`currentTurn` on a no-error `reason=restart` close (the managedRun-exit reject
path re-enters `closeLiveSession` and is short-circuited by the guard), orphaning
the turn's promise → the awaiting reply run never clears its session
(`stalled_agent_run`, `recovery=none`). Prod logs corroborate: closes are
**only** `reason=restart` (never `reason=abort`), i.e. `abortTurn` (which would
settle the turn with an error) is not firing, so `currentTurn` is plausibly still
pending at the restart-close.

A local patch (`fix/claude-live-restart-orphaned-turn`: add
`else if (session.currentTurn) failTurn(session, createAbortError())`) addresses
this, but **has never actually run in the gateway** — it lives only in a test
clone, while the running gateway loads the published `openclaw@2026.6.11` package
(no patch). Correctness of the patch is therefore **unverified**; it must be
built into the deployed package and the gateway **restarted** (a long-lived
detached process; a disk rebuild alone does not reload it) before the fix can be
evaluated against the live stall.

## Update (2026-07-02, part 2) — patch deployed, guard hypothesis disproven, definitive root cause

The candidate patch above **was built into the running gateway and restarted**,
then the stall was reproduced with `VK_SERIALIZE_INBOUND=false`. Findings:

1. **The guard-swallowing hypothesis is wrong.** With `close-entry` logged
   *before* the `session.closing` guard, every close shows
   `reason=restart alreadyClosing=false hasTurn=no hasError=no`. The turn is
   **not attached** to the session at close time, so the reentrancy guard is not
   swallowing a pending turn, and the `failTurn` patch never triggers for this
   stall (it is a harmless defensive improvement for other restart-close paths,
   but **does not fix** this hang — the stall reproduces with it deployed).

2. **The hang is `await outputPromise`** at
   `src/agents/cli-runner/claude-live-session.ts` (the turn's
   `return { output: await outputPromise }`). For a stuck run this promise never
   resolves. A Node diagnostic report (`--report-on-signal`) taken during a live
   stall shows an **idle JS stack** with no model I/O and no outbound send — a
   pure promise deadlock, not a blocked syscall.

3. **The no-output watchdog cannot rescue it.** Instrumenting the watchdog shows
   `noOutputTimeoutMs = 600000` (10 min: `timeoutMs` 600000 × ratio 0.8, clamped
   to the profile max) and, critically, it **re-arms on every stdout chunk**
   (`resetNoOutputTimer` is called from `handleClaudeStdout`). During the stall
   the child keeps emitting stdout (it is digesting the steered-in 2nd message),
   so the 10-minute silence timer is perpetually reset and **never fires**
   (`no-output-fire` count = 0 across all repros). The safety net is a
   *silence* detector, and the corrupted turn is not silent — it produces output
   forever without ever producing a terminal `result`.

4. **The stall is timing-dependent, not deterministic at `queueDepth=2`.** It
   requires the 2nd message to land **while claude-cli is still generating** the
   1st turn (steered into the same stdin via `writeTurnInput`). If the 2nd
   message arrives after the 1st turn has already finished, it is simply the next
   queued turn and completes cleanly (observed live: a `queueDepth=2` that closed
   normally 6 s later with `hasTurn=no`). A trivial 1st prompt (fast turn) does
   not reproduce; a long-running 1st prompt (wide window) does.

**Definitive root cause:** the claude-cli live backend allows a concurrent 2nd
inbound to be **steered into a still-running turn**, which corrupts that turn's
completion detection — `outputPromise` never resolves — and the no-output
watchdog (10 min, reset on every stdout) never catches it. Unlike the API
(`anthropic-messages`) backend, a claude-cli turn driven over stdio **cannot be
safely interrupted mid-flight**.

## Update (2026-07-02, part 3) — isolated repro proves the CLI machinery is clean; defensive core fix

A deterministic offline harness (`cli-runner.spawn.test.ts`, STALL REPRO block) was
built with a faithful mock claude-cli (streaming stdout, writable stdin, `wait()`
that resolves on `cancel()` like the real supervisor). It drives a real
`executePreparedCliRun` and interrupts it mid-turn. Findings:

- **Interrupting an active CLI-live turn settles cleanly** (before result, after an
  aborted result, and with MCP delivery capture) — all scenarios settle in
  <300 ms. An earlier "hang" was a *mock artifact* (a `wait()` that never resolved
  made `waitForManagedRunExit` burn its 5 s timeout); with a faithful mock it is
  gone.
- **Concurrent reply runs on one `sessionKey` are impossible** — the reply-run
  registry throws `ReplyRunAlreadyActiveError`. So a 2nd inbound never becomes a
  second concurrent run; the dispatch layer routes it (steer/queue/interrupt).
- **Steer injection into a CLI run is rejected** — `queueEmbeddedAgentMessage`
  targets `ACTIVE_EMBEDDED_RUNS`, populated only by the API/embedded path
  (`attempt.ts`), never the CLI path → steer falls back to a normal queue.
- **The core already serializes CLI execution** per owner/session via
  `enqueueCliRun(owner:<ownerKey>)`, and all post-turn waits are bounded (5 s / 15 s).

Every isolated path handles the 2nd-message-during-CLI-turn correctly. So the stall
is an **emergent cross-layer interaction**, not a single orphaned await — which is
why it resists isolated static/unit reproduction.

**The leak seam** (`get-reply-run-queue.ts` `resolvePreparedReplyQueueState`): when a
run-now admission preempts the active run and `waitForActiveRunEnd` times out
(15 s) with the run **still registered under the same sessionId**, the old code just
returned "Previous run is still shutting down" and **left the run registered**. A
CLI-backed run whose owner hangs after the turn settles never calls
`operation.complete()`, so it lingers holding the session lock forever
(`stalled_agent_run`, `recovery=none`) until the ~15-min stuck-session abort. Note
`abortReplyRunBySessionId` only *signals* (`operation.abortByUser()`) — completion is
the run owner's job.

**Defensive core fix (shipped 2026-07-02, dormant behind the fork serialization):**
`resolvePreparedReplyQueueState` now force-clears the stuck run
(`forceClearReplyRunBySessionId`) when, after the teardown wait, it is still active
**and still the same run we preempted** (same-sessionId guard, so a freshly started
run is never touched). This is not a task timeout — it clears the registry state of
an already-preempted run so the session recovers instead of leaking. Unit-tested in
`get-reply-run-queue.test.ts`.

## Update (2026-07-02, part 4) — root cause pinned: unbounded wait on deferred maintenance

Following the instrumentation trail (`runPreparedCliAgent` never returns, yet
`executePreparedCliRun` is provably clean under interrupt) led to the **start** of
`runPreparedCliAgent`, not its post-abort path:

`runPreparedCliAgent` opens with
`await waitForDeferredTurnMaintenanceForSession(sessionKey)`
(`agents/cli-runner.ts`, "Reads for the next same-session inference must observe
that rewrite"). That helper did an **unbounded** await:

```ts
await activeDeferredTurnMaintenanceRuns.get(normalizedSessionKey)?.promise;
```

Deferred turn maintenance is a background session rewrite that runs in its **own
lane** (`enqueueCommandInLane("turn-maint:" + sessionKey, …)`). If that lane
stalls, its promise never resolves, and **every subsequent turn on the session
hangs at the very first `await` of `runPreparedCliAgent`, before the model runs**.
This finally reconciles all the puzzling evidence:

- `executePreparedCliRun` tests clean under interrupt — because in the stall it is
  **never reached** (the hang is upstream, at the turn's start).
- Instrumentation showed `runPreparedCliAgent` never returning — it is blocked on
  its opening `await`.
- `lastProgress=cli_live:result` is from the **previous** turn; the stuck run is a
  later turn that never got to spawn.
- The stall is emergent — it needs a stalled maintenance lane, which concurrent
  inbound (a 2nd message contending on session-store state) can induce.

**Root fix (shipped 2026-07-02).** `waitForDeferredTurnMaintenanceForSession` is
now bounded by `DEFERRED_TURN_MAINTENANCE_WAIT_TIMEOUT_MS` (30 s) via
`Promise.race`. On timeout the turn proceeds with possibly-stale reads instead of
deadlocking. This bounds a wait on a **background** task; it is not a per-turn/task
timeout, so a legitimately long user turn is unaffected. Unit-tested in
`context-engine-maintenance.deferred-wait.test.ts` (a never-resolving maintenance
promise resolves the wait within the timeout instead of hanging).

Both fixes ship together: the defensive `get-reply-run-queue` force-clear (breaks
the terminal registry leak) and this root bound (prevents the hang at the source).
The fork's per-peer inbound serialization remains as belt-and-suspenders.

**Fix (does not touch timeouts).** Serialize inbound **per conversation** for
CLI backends: never write a 2nd message into a running claude-cli turn — queue it
until the current turn completes. This is exactly what our VK fork's
`serializeImmediate` (per-peer serialization) does, and it is the correct
behavior for stdio CLI backends. It deliberately avoids any fixed/total turn
timeout, so a legitimately long-running task still runs to completion — it just
starts the 2nd message afterwards instead of corrupting the first. A general
core fix would apply the same per-conversation serialization to all CLI-live
backends (or, failing that, make the watchdog track "no terminal result despite
output" rather than pure stdout silence).

## Update (2026-07-03, part 5) — SUPERSEDED by part 6 (kept for the record)

> **This conclusion was wrong.** #98835 did NOT fix this hang — the two clean
> `queueDepth=2` runs cited below simply missed the timing window; the stall
> reproduced on the next attempt. The real root is pinned in **part 6**
> (transcript-mirror completion deadlock). #98416/#98835 are a *different*
> symptom (reply-session-init false-conflict). Read part 6 for the resolution;
> this section is retained only to show the dead end.

The parts 3–4 hypotheses above (deferred-maintenance wait, get-reply-run-queue
force-clear, clearRestartRecoveryDeliveryContext store-write hang) were all WRONG —
inferred without checking prod logs first, then refuted by live instrumentation:

- Context engine is disabled here (`[context-engine]` count = 0 in prod logs), so the
  deferred-maintenance path never runs.
- Live store-writer instrumentation on a real stall showed every store write completed
  (`REQUEST→ACTIVE→DONE`), `clearRestart` completed, and the process stayed responsive
  (writes after the stall onset still drained). So the stuck run does NOT hang on an
  await and does NOT hold a lock — it reaches its finally but its reply operation is
  never marked complete → it leaks as `stalled_agent_run recovery=none`.
- The dispatch of the 2nd message just *queues* (queueDepth=2); it never takes the
  run-now/interrupt path, so the force-clear never fires.

**Actual root (per maintainer + Slack reporter on #98416):** published `2026.6.11` ships
a stale, non-reentrant `store-writer-queue` dist AND a wide optimistic-concurrency guard
in reply-session initialization (comparing the whole entry between snapshot and commit,
so volatile `updatedAt`/heartbeat/delivery fields trip it). Concurrent same-store writes
make that commit lose. Two manifestations of the one cause: a `reply session
initialization conflicted` per-message drop (Slack/webchat, self-recovers) and — in the
reply path — a completion leak that surfaces as a **stuck session** (VK/this report).

We build our dist from source, so we already had the reentrancy guard; we were only
missing the guard-narrowing fix. **Fix: cherry-picked #98835 (`826c84ea`, "narrow
reply-session initialization revision to identity fields" — identity-only guard +
`mergeConcurrentReplySessionMetadata`).** With it deployed and inbound serialization off,
queueDepth=2 occurred twice with both runs completing and zero stalls, where the same
scenario reliably stalled before. Awaiting upstream republish of `2026.6.11` with the fix.

## Update (2026-07-03, part 6) — RESOLVED: exact root cause + fix

After bisecting the reply-dispatch flow with runId-tagged markers (and a stuck-op
inspector wired through the stall detector, because `logVerbose` is a no-op inside
`reply-run-registry.ts` / `store-writer-queue.ts` due to import cycles), the exact
hang is pinned and fixed.

**Root cause (confirmed by ground truth + code):**
`dispatch-from-config.ts` `mirrorTranscriptAfterDispatcherDelivery(...)` opens with
`await params.dispatcher.waitForIdle();` (no abort, no timeout). It is called from
`sendFinalPayload` — i.e. **while still inside the reply dispatch, before the reply
operation completes**. `dispatcher.waitForIdle()` waits for the whole dispatcher to
drain. When a follow-up is queued (`queueDepth>=2`), the dispatcher cannot idle
until this operation clears, and the follow-up cannot start until this operation
clears — but this operation only clears after `sendFinalPayload` returns, which is
blocked here. Circular deadlock. The reply operation stays `phase=running`
(confirmed live: `stuckOp=[phase=running result=null inRegistry=y]`), surfacing as
`stalled_agent_run recovery=none` until the ~15-min stuck-session abort.

Stuck-run marker trace: `sendfinal-enter -> sf-tts-exit -> sf-route-exit ok=n ->
sf-dispsend queuedFinal=y -> sf-mirrorAfter-enter -> (silence)`.

Not #98416/#98835 (those are the reply-session-init false-conflict / per-message
drop — a different symptom), not the store-writer queue, not context-engine
maintenance (disabled here). Earlier guesses (waitForPendingDirectBlockReplyDelivery,
completeDispatchReplyOperation ordering) were on code paths never reached for this
backend.

**Fix (no timeout, no added latency):** make the transcript mirror **fire-and-forget**
instead of awaiting it:
```ts
void mirrorTranscriptAfterDispatcherDelivery({ dispatcher, before, metadata, cfg })
  .catch((error) => logVerbose(`background transcript mirror failed: ${formatErrorMessage(error)}`));
```
The transcript mirror is post-delivery bookkeeping and does not need to block the
reply operation's completion. With it detached, `sendFinalPayload` returns
immediately, the operation completes, the queued follow-up proceeds, the dispatcher
goes idle, and the (backgrounded) mirror's `waitForIdle` resolves and records the
transcript. Validated live on a real VK install (queueDepth=2 repeatedly, zero
stalls, `sendfinal-exit` fires, no background-mirror errors).

**Separate observation (not this bug):** a long reply's TTS synthesis
(`maybeApplyTtsToReplyPayload`) can take ~100 s for a very long text (XTTS synthesizes
the whole reply at once). The reply operation is legitimately busy during synthesis,
so the ≥180 s stall detector can *false-positive* flag it — but it completes
(`sf-tts-exit` fires); it is not a hang. Short conversational replies synthesize in
1–3 s and never trip the detector.
