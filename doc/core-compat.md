# Core compatibility surface

This plugin runs unmodified on OpenClaw **2026.7.1, 2026.8.1 and 2026.8.2**.
This file lists every place where behaviour depends on the core version, so
dropping an old core is a mechanical edit rather than an archaeology session.

## How OpenClaw does this

OpenClaw has no per-version source layout, and neither should we. The core's
own convention (`docs/plugins/compatibility.md`) is:

- one code path, guarded by capability checks rather than version branches;
- a machine-readable compatibility registry (`code`, `status`, `owner`,
  `removeAfter` or `removalGate`, `replacement`) that drives removals;
- `@deprecated` annotations that name the replacement;
- a manifest floor — `openclaw.compat.minGatewayVersion` — that says which core
  a plugin needs.

Published plugins follow the simplest form of this: they pin a floor and move
it up. The two third-party plugins installed next to us (`@openclaw/searxng-plugin`,
`@openclaw/deepseek-provider`) both declare `>=2026.8.2` and contain no version
conditionals at all. Supporting three cores at once, as we do, is a deliberate
extra: it is what keeps this fork installable on a gateway that has not been
updated yet.

## Marker convention

Every version-dependent branch carries a greppable marker:

```
core-compat: <oldest core that needs it> · <what the branch is> · <removal condition>
```

```bash
grep -rn "core-compat:" src/
```

The removal condition is always phrased against the manifest floor, so raising
`openclaw.compat.minGatewayVersion` is the single trigger for a cleanup sweep.

## Current branches

| Where | Branch | Remove when floor reaches |
|---|---|---|
| `src/sdk-compat.ts` — `readCoreConfig()` | `config.loadConfig()` (2026.7) vs `config.current()` (2026.8) | 2026.8.1 — body collapses to `source?.config?.current?.()` |
| `src/status-patches.ts` | hand-built ready/stopped patches when `channelReadyPatch`/`channelStoppedPatch` are missing | 2026.8.1 — module disappears; import the two builders from `gateway-runtime` directly |
| `src/inbound.ts` — envelope | `formatAgentEnvelope` absent on 2026.7; body is sent unwrapped | 2026.8.1 — restore the named import |
| `src/monitor.ts` — `onFlush` | 2026.7 awaits a promise; 2026.8 wants `{admission, completion}` from `createFlush` | 2026.8.1 — keep only the `createFlush` path |
| `src/progress-draft.ts`, `src/sdk-compat.ts` | inverted case: `ChannelProgressDraftCompositor`, `StreamingCompatEntry` and `ChannelProgressDraftMode` exist **only** in 2026.7 | never — the compositor type is derived from the factory's `ReturnType`, the other two are local copies; both are correct on every version |
| `src/monitor.ts` — `resolveSerializeInbound()` | per-peer inbound serialization for cores without the fire-and-forget mirror fix | **already dead**: the fix landed in 2026.7.1, which is now the manifest floor, so the version arm can never be true. Pending a decision: drop the workaround with it, or keep `VK_SERIALIZE_INBOUND` as a manual escape hatch |

Ownership of channel restart is **not** a branch: the core's restart policy
(5s → 5min, factor 2, ten attempts, reset after a stable run) is identical in
2026.7.1 and 2026.8.2. The plugin never restarts itself on any supported core.

## Deprecated subpaths we still import

`npm run report:deprecations` compares our imports against the core's own
compatibility registry and prints status, `removeAfter` and the replacement.

One import remains flagged:

- `openclaw/plugin-sdk/channel-lifecycle` (`plugin-sdk-channel-lifecycle-subpath`,
  `removeAfter: 2026-09-01`, replacement `channel-outbound`) — used for
  `createArmableStallWatchdog` only.

  **This one cannot be migrated yet.** The documented replacement does not
  export that symbol: in both 2026.7.1 and 2026.8.2, `createArmableStallWatchdog`
  (and the `ArmableStallWatchdog` / `StallWatchdogTimeoutMeta` types) exist only
  in the deprecated facade. Everything else this plugin used from
  `channel-lifecycle` and `channel-message` has already moved to
  `channel-outbound`.

## Verifying

`npm run check:core-compat` builds a sandbox with the real core of each
supported version and imports every emitted module separately. It exists
because this failure class is invisible otherwise: a missing named export
breaks ESM *linking*, so the plugin silently fails to load and the channel just
disappears. The build does not catch it (esbuild does not typecheck) and unit
tests do not either (they mock the SDK).
