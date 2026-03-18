# VK OpenClaw Plugin Agent Guide

## Scope
This directory contains the OpenClaw VK channel plugin (`id: vk`) implemented as a native OpenClaw plugin.

## Current Launch Status (Verified)
Verified on **March 18, 2026** (Europe/Moscow):

- `pnpm test:extension vk` (run from OpenClaw repo root) passed:
  - 4 test files
  - 55 tests
  - 0 failures
- `pnpm openclaw plugins list` includes `@openclaw/vk` with plugin id `vk`.
- `pnpm openclaw plugins inspect vk --json` confirms:
  - `format: openclaw`
  - `status: disabled` (expected for bundled plugins by default)
  - `configSchema: true`

This confirms the plugin is discoverable and its extension test suite is green in the current workspace.

## Local Code Map
- `index.ts`: channel plugin entry (`defineChannelPluginEntry`)
- `setup-entry.ts`: setup wizard entry (`defineSetupPluginEntry`)
- `openclaw.plugin.json`: plugin manifest (`id`, channels, config schema)
- `src/config-schema.ts`: account/channel config JSON schema builder
- `src/channel.ts`: main channel behavior (routing, security, status, gateway start/stop)
- `src/channel.setup.ts`: setup-time plugin surface
- `src/setup-core.ts`: setup-side core operations (probe, account persistence)
- `src/setup-surface.ts`: setup UI/runtime bridge used by setup entry
- `src/accounts.ts`: account resolution and normalization helpers
- `src/runtime.ts`: runtime singleton access (`getVkRuntime` / `setVkRuntime`)
- `src/monitor.ts`: VK updates polling and inbound event bridge
- `src/inbound.ts`: inbound normalization, policy checks, dispatch to OpenClaw runtime
- `src/send.ts`: outbound messaging via VK API
- `src/probe.ts`: token/bot probe via `groups.getById`
- `src/types.ts`: shared plugin runtime/config/message types

## Module Format
- The plugin is already **TypeScript + ESM**:
  - `package.json` has `"type": "module"`
  - entrypoints are `.ts` files compiled by OpenClaw build/runtime scripts
- Converting to plain JS ESM is optional and usually only useful when you want to drop TS toolchain/tests.

## Minimal Runtime Smoke Check
Run from OpenClaw monorepo root:
1. `pnpm test:extension vk`
2. `pnpm openclaw plugins inspect vk --json`
3. `pnpm openclaw plugins enable vk` (if you need an enabled local run)
4. `pnpm openclaw plugins list`

Expected checkpoints:
- tests stay green
- inspect reports `format: openclaw` and `configSchema: true`
- list shows `vk` as enabled after step 3

## Telegram Reference Implementation
Use the Telegram channel in the sibling extension as the primary style and architecture reference:

- `../telegram/index.ts`
- `../telegram/setup-entry.ts`
- `../telegram/src/channel.ts`

When in doubt, mirror Telegram’s patterns for:
- plugin entry wiring
- account-scoped config and security behavior
- outbound/inbound adapter shape

## Aggregated External Sources
Collected from the requested links on **March 18, 2026**.

### 1) VK/Habr onboarding article
- URL: https://habr.com/ru/companies/vk/articles/570486/
- Why useful: practical bot-development flow (idea -> community setup -> update delivery -> token -> messaging features).
- Key points to retain:
  - choose update transport: Callback API or Long Poll
  - configure community messages before bot launch
  - use scoped access tokens and do not expose them publicly
  - message delivery relies on `messages.send`
  - group chat bot permissions and bot levels matter for behavior in chats

### 2) VK Bots overview (official)
- URL: https://dev.vk.com/ru/api/bots/overview
- Why useful: official product-level definition and scope of VK community bots.
- Key points to retain:
  - bots are built around **community messages**
  - platform is cross-client/cross-platform for VK users
  - primary docs path starts from the bots quick start

### 3) OpenClaw channel catalog
- URL: https://docs.openclaw.ai/channels
- Why useful: channel-level expectations inside OpenClaw and plugin positioning.
- Key points to retain:
  - channels can run simultaneously
  - group behavior and DM safety policies are first-class concerns
  - Telegram is the fastest baseline setup and a useful behavior benchmark

### 4) OpenClaw CLI plugin operations
- URL: https://docs.openclaw.ai/cli/plugins
- Why useful: authoritative operational commands and packaging constraints.
- Key points to retain:
  - core commands: `list`, `inspect`, `enable`, `disable`, `install`, `uninstall`, `update`, `doctor`
  - native plugins require `openclaw.plugin.json` with inline JSON schema (`configSchema`, even if empty)
  - bundled plugins start disabled and are explicitly enabled

### 5) vk-io introduction
- URL: https://negezor.github.io/vk-io/ru/guide/introduction.html
- Why useful: runtime SDK characteristics used by this plugin.
- Key points to retain:
  - Node.js SDK with 1:1-ish API mapping (`vk.api.*`)
  - broad VK API coverage with TypeScript-first ergonomics
  - supports bot ecosystem patterns used by Long Poll / updates handling

### 6) OpenClaw plugin architecture
- URL: https://docs.openclaw.ai/tools/plugin
- Why useful: defines plugin capability model and runtime boundaries.
- Key points to retain:
  - native plugin runtime behavior comes from `register(api)`
  - channel plugins register messaging capability (`registerChannel`)
  - discovery/validation should be manifest-driven without executing plugin code
  - plugin shape and capability ownership are explicit and inspectable

## Testing Gotchas (discovered 2026-03-18)

### vk-io VK class mock — must use regular function, not arrow
```ts
vi.mock("vk-io", () => ({
  VK: vi.fn().mockImplementation(function () { return { api: ..., updates: ... }; }),
}));
```
Arrow functions cannot be called with `new`; Vitest warns and throws `is not a constructor`.

### Reset VK mock call count in beforeEach
```ts
vi.mocked(VK).mockClear(); // after clearVkInstances()
```
Required when asserting `toHaveBeenCalledTimes` on the constructor — counts accumulate across tests otherwise.

### Registering openclaw/plugin-sdk/vk alias for Vitest
`"vk"` must be present in `scripts/lib/plugin-sdk-entrypoints.json` in the monorepo.
Without it, Vitest cannot resolve the `openclaw/plugin-sdk/vk` alias and the inbound test suite fails to load entirely.

### AbortController in fake-timer tests
The mock fetch must listen to `opts?.signal` and reject with `AbortError`; otherwise the promise never settles and the test times out at 120 s.
```ts
global.fetch = vi.fn().mockImplementation((_url, opts) => new Promise((_, reject) => {
  opts?.signal?.addEventListener("abort", () =>
    reject(new DOMException("The operation was aborted.", "AbortError")));
})) as unknown as typeof fetch;
```

### Token scopes and Long Poll selection
- `manage` scope → `groups.getLongPollServer` succeeds → Bots LP (`vk.updates.start()`)
- `messages` scope only → `groups.getLongPollServer` throws → User LP (`vk.updates.startPolling()`)

### Test commands
- From monorepo root: `pnpm test -- extensions/vk`
- Single file: `pnpm test -- extensions/vk/src/inbound.test.ts`

## Practical Rules For Future Changes
- Keep VK plugin behavior aligned with OpenClaw channel policy patterns (pairing, allowlists, group policy).
- Keep manifest/schema valid and minimal; never remove `configSchema` from `openclaw.plugin.json`.
- Prefer Telegram extension behavior as the compatibility reference when implementing channel lifecycle changes.
- Re-run these checks after edits:
  1. `pnpm test:extension vk`
  2. `pnpm openclaw plugins inspect vk`
