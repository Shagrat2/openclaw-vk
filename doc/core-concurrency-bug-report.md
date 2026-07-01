# Upstream bug report — core concurrency on a 2nd message per session (2026.6.11)

Draft for an openclaw core issue (or a comment on the existing
**#98562 "reply session initialization conflicted"**). Discovered while running
the VK channel, but the failure is in **core reply-dispatch / session
initialization**, not in the channel plugin.

## TL;DR

When a second inbound message for the **same session** is handled close to the
first, core breaks in one of two ways depending on *how* the second message
reaches the dispatcher:

1. **Queued concurrently (queueDepth ≥ 2) → deadlock.** The in-flight reply's
   `waitForReplyDispatcherIdle` never resolves while a message is queued, so the
   first reply hangs and the whole session lane is stuck until the 15-minute
   stuck-session abort fires.
2. **Dispatched right after the first completes → `reply session
   initialization conflicted`.** The session stays "poisoned" for several
   seconds after a message completes; every reply-session init for that session
   key fails the optimistic commit at `auto-reply/reply/session.ts:936`, and
   retries do **not** recover it.

Either way, the second message never gets a reply, and case (1) also freezes the
first reply and the entire lane.

## Environment

- openclaw **2026.6.11** (pnpm install), local gateway daemon (macOS).
- Channel: VK, `deliveryMode: "direct"` (same path as discord/slack/matrix).
  Plugin: [pfrankov/openclaw-vk](https://github.com/pfrankov/openclaw-vk)
  (upstream). Repro + workaround live in our fork
  [Shagrat2/openclaw-vk](https://github.com/Shagrat2/openclaw-vk), branch
  `temp/vk-concurrency-workarounds`.
- Backend: `claude-cli` (local), single agent `main`, session key
  `agent:main:vk:direct:<peer>`.
- Reproduces with plain text messages; media/TTS not required.

## Reproduction

1. Send message **A** to the agent in one conversation.
2. While A is still being processed (before its reply is delivered), send
   message **B** in the **same** conversation.

Result depends on delivery timing (both observed):

- **B is queued while A dispatches** → A's reply hangs ~15 min (deadlock),
  recovered only by the stuck-session abort.
- **B is dispatched just after A completes** → B fails immediately with
  `reply session initialization conflicted for agent:main:vk:direct:<peer>`.

## Evidence

### Case 1 — deadlock (queued 2nd message)

```
message processed: ... messageId=3513 ... duration=979363ms reason=reply_operation_abort
```

A single reply took **979363 ms (~16 min)** — it did not actually run that long,
it hung in `waitForReplyDispatcherIdle` until `reply_operation_abort`
(stuck-session abort, `diagnostics.stuckSessionAbortMs`, default 900000 ms).
During that window the lane processed nothing.

### Case 2 — session-init conflict (2nd message right after the 1st)

First message completes normally, then the 2nd fails within ~30 ms, before any
turn is created — and it keeps failing on every retry over 6+ seconds:

```
16:28:30.674 message dispatch completed: messageId=3527 outcome=completed duration=30431ms   ← msg A ok
16:28:30.689 session state: prev=processing new=idle reason="message_completed" queueDepth=0
16:28:30.986 message received:  messageId=3528                                                ← msg B
16:28:31.010 message dispatch started: messageId=3528
16:28:31.040 session state: prev=processing new=idle reason="message_error" queueDepth=0      ← 30 ms, no turn
16:28:32.9xx (retry) → message_error
16:28:34.8xx (retry) → message_error
16:28:36.7xx (retry) → message_error
... vk: message handler error: reply session initialization conflicted for agent:main:vk:direct:12324712
```

The error is thrown here:

```ts
// src/auto-reply/reply/session.ts:936
if (!committed.ok) {
  if (!staleSnapshotRetried) {
    return await initSessionStateAttemptLocked(params, attemptContext, true); // core retries once
  }
  throw new Error(`reply session initialization conflicted for ${sessionKey}`);
}
```

So the optimistic commit of the reply-session init fails, core retries once
internally, fails again, and throws. Notably this persists for **several seconds
after the first message completed** — it is not a sub-millisecond race.

## What we tried (from the channel side) and what it tells you

We run a forked VK plugin, so we could experiment with the delivery path:

1. **Per-peer serialization of inbound** — chain handlers so core never sees
   `queueDepth ≥ 2` for a conversation. ✅ **Eliminates the deadlock (case 1).**
   The first message always completes and the lane stays live. This strongly
   suggests the deadlock is specifically the *queued-message* path in
   `waitForReplyDispatcherIdle`.
2. **Settle delay (~750–960 ms) before dispatching the 2nd message** — ❌ does
   not avoid the conflict (case 2).
3. **Retry the whole inbound handler on the conflict**, 3× with 1.5 s backoff —
   ❌ all 4 attempts (initial + 3 retries) fail over ~6 s. Each failed attempt
   appears to re-touch the session row and re-trigger the conflict.

Conclusion: **case 2 is not recoverable from outside core.** The session is left
in a state where a fresh reply-session init cannot commit for seconds after the
previous message completed.

## Suspected root cause / questions for maintainers

- Case 1: `waitForReplyDispatcherIdle` (in `auto-reply/reply/dispatch-from-config.ts`)
  waits for idle but a queued message keeps it non-idle → self-deadlock. Should
  a queued same-session message enqueue behind the active reply instead of
  blocking it?
- Case 2: what writes the session row between the snapshot read and the commit
  in `initSessionStateAttemptLocked`, and why is it still writing seconds after
  `message_completed`? A post-completion async writer (session meta / archival /
  memory flush?) that outlives `reply_operation` would explain the persistent
  stale-snapshot conflict. Should init wait for that writer, or should the
  commit be idempotent/last-writer-wins for a completed session?

## Impact

- Any user sending two quick messages in one conversation hits this.
- Case 1 is the worst: one hung reply freezes the entire lane for 15 minutes.
- Case 2 is a fast, visible failure (the channel surfaces an error) but the
  second message is silently lost unless the user resends after a pause.

## Our mitigation (channel-side, temporary)

We serialize inbound per peer in the VK plugin (fixes case 1). We deliberately do
**not** try to paper over case 2 — it needs a core fix. See `src/monitor.ts`
(`inboundChainByPeer`, `VK_SERIALIZE_INBOUND`) in our fork:
[Shagrat2/openclaw-vk @ `temp/vk-concurrency-workarounds`](https://github.com/Shagrat2/openclaw-vk/tree/temp/vk-concurrency-workarounds).
