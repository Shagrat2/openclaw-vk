# VK diagnostics: three levels, and why `full` is kept

This document answers the blocking diagnostics review comment on
[PR #8](https://github.com/pfrankov/openclaw-vk/pull/8). It states plainly that
this branch keeps an opt-in `full` level that can log names, and explains why we
believe it should exist.

All log excerpts below are illustrative and contain no real identifiers, paths,
or URLs.

## What the review asked for, and what changed

> Please remove this mechanism or replace it with the normal structured runtime
> logger. Log only safe fields such as: stage; error code/class; source kind
> (`local`, `remote`, `data`); MIME type and byte count; attempt; segment
> index/count.
>
> Do not log complete URLs, peer IDs, local paths, data URLs, or media contents.

Addressed:

- **Replaced with the structured runtime logger.** `VK_VOICE_DEBUG_LOG` is no
  longer the transport. Diagnostics now go through
  `runtime.logging.getChildLogger()`, so they inherit the gateway's levels,
  formatting, and rotation.
- **No file of its own.** The previous revision kept an optional secondary
  file sink; it is gone. A plugin-owned file has none of the gateway log's
  safeguards — no rotation, no size limit, no restricted permissions on
  creation — and an unbounded write queue behind it is a memory leak waiting
  for a slow disk. Operators who find the gateway feed too noisy filter it by
  the `vk-diag` module binding instead.
- **Redaction is a property of the channel, not caller discipline.** Every field
  passes through one redactor, so a new call site cannot forget to sanitise its
  own value.
- **Below `full`, nothing free-form survives.** The previous revision tried to
  recognise paths and addresses inside text and strip them. That is a losing
  game — a Unicode path, a path with spaces, a relative one, a data URI in the
  middle of an error message: each escaped one pattern or another. The rule is
  now an allowlist, by field name and value type:

  | what | at `off` / `redacted` |
  |---|---|
  | identifier fields (`to`, `peerId`, `messageId`, …) | hashed with `redactIdentifier` from the SDK |
  | numbers, booleans | as they are |
  | token fields (`kind`, `mime`, `stage`, `errorName`, `errno`) | kept only if the value looks like a token |
  | source fields (`source`, `mediaUrl`, `url`, `path`, …) | replaced by the kind: `local` / `remote` / `data` |
  | any other string, error messages included | the constant `<text>` |
  | an `Error` | its class, numeric code and `errno`-style code; never its message |
  | buffers and typed arrays | the constant `buffer` |

  Nothing in that table depends on recognising what a string contains, so a
  path shape the code has never seen still cannot reach the log.
- **Attachment contents never reach the log, at `full` either.** The payload of
  every data URI — standalone or embedded in a message — is replaced by its
  length; the MIME type and parameters stay. The core's secret redactor runs
  over the rest, plus a pass of our own for what it does not cover: checked
  against the real `plugin-sdk/logging-core`, it leaves a credential in a URL's
  query string (`?access_token=…`) and a bare VK token (`vk1.a.…`) as they are,
  and both can appear in an error thrown by vk-io. Text is capped.
- **Levels instead of a single toggle**, defaulting to silent:

  | level | contents |
  |---|---|
  | `off` (default) | nothing |
  | `redacted` | the safe-field list quoted above, plus hashed identifiers for correlation |
  | `full` | the safe fields plus names: paths, URLs, peer ids |

- **`redacted` is what we run day to day.** It is the level configured in our
  own deployment; `full` is switched on for a specific investigation and off
  again afterwards.
- **Identifiers survive as hashes, not as names.** `redactIdentifier` gives a
  stable `sha256:…` prefix, so two failed sends to different recipients stay
  distinguishable in the timeline without naming anyone. This is the core's own
  convention — the bundled Discord plugin redacts the same way.

Configuration is native to OpenClaw and hot-reloaded:

```json
{ "channels": { "vk": { "diagnostics": { "level": "redacted" } } } }
```

An unrecognised value resolves to `off` rather than to something more verbose.
This holds for the environment override too: a set but invalid `VK_DIAG_LEVEL`
is `off`, and does *not* fall through to a `full` configured in the file. Both
are unit-tested, so a typo cannot silently widen what is logged.

## Why `full` is kept

The safe-field set is enough to **detect** a problem. It is often not enough to
**reproduce** one, and delivery bugs in this channel are reproduced by re-running
the exact input.

### 1. Identical safe fields, different root causes

A remote attachment rejected by VK produces this at `redacted`:

```
vk upload failed  kind=photo source=remote mime=image/jpeg bytes=182034 attempt=3
                  code=100 reason="photo is undefined"
```

At least three unrelated causes produce that exact line: an expired signed URL,
a host VK's fetchers cannot reach, and a URL that resolves to an HTML error page
served with an image content type. Nothing in the permitted field set separates
them — and a hashed identifier, while enough to correlate two events, cannot be
fetched or inspected. Each cause has a different fix. The URL separates them:

```
mediaUrl=https://cdn.example.org/renders/2f8c1a.jpg?expires=1750000000&sig=…
```

### 2. Silent wrong-attachment delivery

The worst class of bug here logs no error at all. Every safe field looks healthy:

```
send payload   media=1 mediaRefs=[local] textLen=412
vk upload ok   kind=photo source=local mime=image/jpeg bytes=177065 attempt=1
media sent     index=1 total=1 messageId=sha256:9f2c1ab04e77
```

…and the recipient still receives the previous render, because the send used a
stale path produced elsewhere in the pipeline. There is no failure to key on and
no byte count that looks wrong. Only the path shows it:

```
mediaUrl=/srv/agent/renders/frame-023-v2.jpg      # expected frame-024-v1.jpg
```

### 3. Correlation across subsystems

When one subsystem writes a file and the channel sends it, the filename is the
only key the two logs share. Without it, "the picture never arrived" cannot be
attributed to production or to delivery, and the investigation alternates
between two innocent components. We spent two debugging rounds in exactly that
state before this level existed.

## Safeguards

- **Off by default**, and off after an unrecognised value.
- **Never implicit.** Nothing escalates the level automatically — not an error,
  not a retry, not a stall.
- **Operator-scoped.** Turning it on requires write access to the gateway
  configuration or its process environment. That is the same trust boundary that
  already holds the group access token, so `full` does not widen who can read
  what; it widens what an operator can see about their own traffic.
- **Failures stay minimal.** Upload failures are logged even at `off`, but only
  by error class and codes — `errorName=APIError code=100`, `errno=ENOENT` —
  never by message, which is where paths and request parameters travel. So a
  channel is never silent about an error, and switching diagnostics off never
  costs an operator the error itself.
- **Tested against the real redactor.** `src/diagnostics.test.ts` runs with a
  test double for the SDK, because the `openclaw` peer is optional;
  `src/diagnostics.sdk.test.ts` repeats the contract through the real
  `plugin-sdk/logging-core` and runs in the CI job that installs the host.
- **Not for shared or hosted deployments.** `full` is documented as a local
  investigation switch. An operator running the gateway on behalf of other
  people should leave the default.

## If upstream still prefers otherwise

We would rather keep `full` behind the explicit switch described here, and we
have stated it openly instead of shipping it quietly. If the maintainer prefers
the strict reading, the level is a single branch in
[`src/diagnostics.ts`](../src/diagnostics.ts): it can be dropped from this PR
without touching anything else, and carried as a fork-local patch instead.
