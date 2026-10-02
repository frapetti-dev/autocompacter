# Repository Guidelines

## Project Overview

**autocompacter** (`@frapetti-dev/autocompacter`) is an [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) extension. When context usage reaches a token threshold at the end of an agent turn, it compacts the session automatically. `/autocompacter` turns it on/off, sets the threshold, and picks the compaction type. Defaults: **off**, **250,000 tokens**, type **`default`** (omp's configured `compaction.methodOrder`).

omp's built-in auto-compaction is left untouched; whichever threshold is lower fires first.

## Architecture & Data Flow

One file, `extensions/autocompacter.ts`, no build step (TypeScript is shipped as-is), zero runtime dependencies. Default export `autocompacter(pi, deps?: { configPath? })`; pure helpers (`parseTokenCount`, `formatTokens`, `validateOverride`, `resolveSettings`, `parseCommandArgs`) are exported for tests.

- **Closure state** (per session binding, never module-level — extension factories are rebound into subagent sessions and module globals are shared): `globalOverride`, `sessionOverride`, `inFlight`, `hostCompacting`, `pendingConfigWarning`.
- **Settings precedence**: defaults < global file < session override. `status` reports the source of each field.
- **Global file**: `<agentDir>/config/autocompacter.json` (`agentDir` = `pi.pi.getAgentDir()` → `PI_CODING_AGENT_DIR` → `~/.omp/agent`). Keys: `enabled`, `thresholdTokens` (1,000–10,000,000), `type`. Loaded at factory time and on every `session_start`; invalid fields are dropped with one warning notify. Written only by `--global` commands.
- **Session override**: stored as a custom session entry, `CUSTOM_TYPE = "frapetti-dev.autocompacter.settings"`, always the full snapshot (not a delta). Restored from the last matching entry of `ctx.sessionManager.getBranch()` on `session_start` / `session_switch` / `session_branch` / `session_tree`.
- **Trigger**: the `agent_end` handler. omp emits it fire-and-forget after the session is idle, so `ctx.compact()` is safe there. The handler is synchronous and must **not** await compaction (handlers are limited to 30 s; compaction can take longer). It starts a detached `ctx.compact({ suppressContinuation: true, mode? })` and reports via `ctx.ui.notify`.
- **Guards** (skip when any holds): disabled; `event.willContinue`; `ctx.agent.kind === "sub"`; `inFlight`; `hostCompacting` (tracked via `auto_compaction_start`/`auto_compaction_end` — a manual `compact` would cancel the host's in-flight one); usage unavailable; `tokens < threshold`. At most one compaction per `agent_end`.
- `type default` omits `mode`, so omp uses `compaction.methodOrder`; other types pass `mode: "soft" | "remote" | "snapcompact"`.

## Key Directories

| Path | Purpose |
| --- | --- |
| `extensions/` | Shipped runtime code (`autocompacter.ts`) |
| `tests/` | `node:test` suite with a fake `pi`/`ctx` harness (offline) |
| `scripts/` | `smoke-rpc.ts` — real-omp smoke test (dev tool, not CI) |
| `.github/workflows/` | `ci.yml`, `publish.yml` |

## Development Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck                                              # tsc --noEmit (extensions + scripts)
pnpm test                                                   # node --test tests/autocompacter.test.ts
node --test --test-name-pattern "<substr>" tests/autocompacter.test.ts
pnpm smoke                                                  # real omp over RPC; needs credentials
```

No build, lint, or format script exists; don't invent one. Run `typecheck` and `test` after any change to `extensions/`. Run `smoke` after behavior changes to the trigger.

## Code Conventions

- ESM, TypeScript `strict`, **erasable syntax only** (tests and the smoke script run the `.ts` directly via Node type-stripping): no enums, parameter properties, or namespaces. `import type` for type-only imports. Relative imports carry the `.ts` extension.
- `node:`-prefixed imports, tab indentation, banner comments (`// ====` + title).
- User-visible notifies start with `🗜️ autocompacter:`.
- Never `await` compaction inside `agent_end`. Every detached promise must be caught — an unhandled rejection kills the omp session.
- Per-session state lives in the factory closure.
- Comments, docs, CHANGELOG in English.

## Runtime/Tooling Preferences

- **pnpm only.** No npm/npx/yarn/bun/bunx. `packageManager` pins pnpm; CI reads it through `pnpm/action-setup`.
- Node ≥ 24 (type-stripping for tests/scripts).
- Zero runtime deps. `@oh-my-pi/pi-coding-agent` is a dev dependency (types only) and an optional peer dependency.
- `pnpm-workspace.yaml` holds pnpm's `allowBuilds` (native build scripts of transitive host deps are disabled — only types are used) and `minimumReleaseAgeExclude` entries.

## Testing & QA

- `tests/autocompacter.test.ts` builds a fake `pi` (records handlers, commands, `appendEntry`) and fake `ctx` (controllable `getContextUsage`, `compact` promise, `notify` log). No network, no real omp.
- Every test uses a temp config path via `deps.configPath`; never touch the real agent dir.
- Test behavior (thresholds, precedence, guards, persistence), not wording of non-essential messages.

## Documentation Sync

| Change | Update |
| --- | --- |
| Any user-visible change | `CHANGELOG.md` (`## [Unreleased]`) |
| Command, config keys, defaults, install | `README.md` |
| Architecture, guards, conventions | this file |

## Smoke-testing against real omp

`pnpm smoke` (`scripts/smoke-rpc.ts`) spawns `omp --mode rpc --no-session --no-extensions -e extensions/autocompacter.ts --tools read --yolo` against a **temp agent dir** (credentials copied from `OMP_SMOKE_SOURCE_AGENT_DIR` or `~/.omp/agent`; `OMP_BIN` overrides the binary) with a config of `{enabled: true, thresholdTokens: 1000, type: "soft"}`. It disables built-in compaction via RPC `set_auto_compaction`, then checks: **A** `/autocompacter status`; **B** a prompt that reads three ~45 KB files triggers `compacting (soft)` then `compacted X → Y tokens`; **C** the transcript contains a `compactionSummary` message; **D** `/autocompacter off` answers `off (session)`. Prints `PASS`/`FAIL` per check; exit 0 only if all pass. Needs working model credentials; not run in CI.

## Release

1. Bump `package.json` version; run `pnpm install` to sync `pnpm-lock.yaml`; move CHANGELOG entries under the new version.
2. Commit `chore(release): bump version to X.Y.Z`; annotated tag `vX.Y.Z`; push the tag.
3. `gh release create vX.Y.Z --verify-tag --notes-file <notes>` → `publish.yml` double-checks tag vs `package.json` version and HEAD, runs typecheck + tests, and publishes to GitHub Packages with `GITHUB_TOKEN`.

## Git & Workflow Conventions

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
- Update the CHANGELOG before merging to main.
