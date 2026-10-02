# Repository Guidelines

## Project Overview

**autocompacter** (`@frapetti-dev/autocompacter`) is an [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) extension. When context usage reaches a token threshold at the end of an agent turn, it compacts the session automatically. `/autocompacter` toggles it, sets the threshold, and picks the compaction type.

Defaults: **off**, **250,000 tokens**, type **`default`** (omp's configured `compaction.methodOrder`). omp's built-in auto-compaction is deliberately left untouched — whichever threshold is lower fires first.

## Architecture & Data Flow

One file, `extensions/autocompacter.ts`; no `src/`, no build step (TypeScript is shipped as-is), zero runtime deps. Sections: types/constants → pure helpers → the `autocompacter(pi, deps?)` factory.

**Pure helpers (exported, unit-tested):** `parseTokenCount` (`250000`/`250k`/`1.5M`, range 1K–10M), `formatTokens`, `validateOverride` (keeps valid fields, returns `problems[]`), `resolveSettings` (`{...DEFAULT_SETTINGS, ...global, ...session}`), `parseCommandArgs` (strips `--global`/`-g`; returns `{error}` on bad input). `errMessage` is module-private.

**Factory closure state — never module-level.** omp rebinds extension factories into subagent sessions and module globals are shared across them. State: `globalOverride`, `sessionOverride`, `inFlight`, `hostCompacting`, `pendingConfigWarning`.

**Settings precedence:** defaults < global file < session override. `sourceOf(key)` reports which scope defines each key (`status` prints it).

**Global file:** `<agentDir>/config/autocompacter.json`. `agentDir` = `pi.pi?.getAgentDir?.()` → `PI_CODING_AGENT_DIR` → `~/.omp/agent`. Loaded at factory time and on every `session_start`. Missing file → `{}` silently; unparseable/invalid fields → dropped, one `warning` notify on the next `session_start`. Written only by `--global` commands (`saveGlobal` re-reads, merges, writes tab-indented JSON). A failed write notifies `error` and leaves in-memory state unchanged.

**Session override:** custom session entry, `CUSTOM_TYPE = "frapetti-dev.autocompacter.settings"`, always the **full snapshot**, not a delta (`pi.appendEntry`). `restoreSession` takes the **last** matching `type === "custom"` entry of `ctx.sessionManager.getBranch()`; wired to `session_start`, `session_switch`, `session_branch`, `session_tree`. `reset` appends `{}`.

**Trigger — `agent_end` handler:**

1. Synchronous. omp emits `agent_end` fire-and-forget after the session is idle, so `ctx.compact()` is safe there, but a handler is limited to 30 s and compaction can run longer → **never `await` it**.
2. Skip when any holds: disabled; `event.willContinue`; `ctx.agent?.kind === "sub"`; `inFlight`; `hostCompacting` (set by `auto_compaction_start`/`_end`; a manual `compact` would cancel the host's in-flight one); usage undefined or `tokens` null; `tokens < thresholdTokens`.
3. Otherwise set `inFlight`, notify, and start a detached `ctx.compact({ suppressContinuation: true })` (type `default`) or `{ mode, suppressContinuation: true }`. `.then` reports `before → after`; `.catch` notifies `error` (itself wrapped in try/catch); `.finally` clears `inFlight`. A synchronous throw from `compact` is converted to a rejected promise.
4. Fires at most once per `agent_end`; no extra loop guard is needed.

**Command:** `pi.registerCommand("autocompacter", …)` with `getArgumentCompletions(prefix)` (items `{ value, label, description? }`; `type <t>` / `threshold <n>` prefixes get specific lists, otherwise the first-word list; `null` when nothing matches). Actions: `status`, `on`/`off`, `threshold <x>`, `type <t>`, `reset`, each optionally `--global`. A global set that is shadowed by a session override appends a "session override still applies" note.

## Key Directories

| Path | Purpose |
| --- | --- |
| `extensions/` | Shipped runtime code (`autocompacter.ts`) |
| `tests/` | `node:test` suite with a fake `pi`/`ctx` harness (offline) |
| `scripts/` | `smoke-rpc.ts` — real-omp RPC smoke test (dev tool, not in CI) |
| `.github/workflows/` | `ci.yml`, `publish.yml` |

## Development Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck        # tsc --noEmit; covers extensions/**/*.ts and scripts/**/*.ts ONLY (not tests)
pnpm test             # node --test tests/autocompacter.test.ts
node --test --test-name-pattern "<substr>" tests/autocompacter.test.ts
pnpm smoke            # node scripts/smoke-rpc.ts — real omp over RPC; needs model credentials
omp -e ./extensions/autocompacter.ts   # try the extension manually
```

There is no build, lint, or format script and no eslint/prettier/biome config — don't invent one. Run `typecheck` and `test` after any change to `extensions/`; run `smoke` after changing trigger/guard behavior.

## Code Conventions & Common Patterns

- ESM, TypeScript `strict`, tab indentation, `node:`-prefixed imports, relative imports carry the `.ts` extension, banner comments (`// ====` + title).
- **Erasable syntax only** (`erasableSyntaxOnly`): tests and scripts run the `.ts` directly via Node type-stripping → no enums, parameter properties, or namespaces. `verbatimModuleSyntax` → `import type` for type-only imports.
- Target/lib `ES2024` (`Promise.withResolvers` is available and preferred over `new Promise(executor)`). Avoid `any`; use `unknown`/real types.
- **Async:** detached promises MUST be fully caught — an unhandled rejection kills the omp session. Never `await` compaction inside `agent_end`.
- **State:** per-session state in the factory closure (see above). Session overrides are persisted as full snapshots.
- **Dependency injection:** only `deps.configPath` (test seam for the config file). Host access is optional-chained (`pi.pi?.getAgentDir?.()`, `ctx.agent?.kind`) so the extension tolerates older hosts.
- **Errors:** user-facing failures go through `ctx.ui.notify(msg, level)`; never throw out of a handler. Validation returns `{ error }` / `{ override, problems }` instead of throwing.
- **Notify text:** always prefixed `🗜️ autocompacter:`; levels `info` / `warning` / `error`.
- Comments, docs, CHANGELOG in English. Conventional Commits.

## Important Files

| File | Why it matters |
| --- | --- |
| `extensions/autocompacter.ts` | The whole extension; default export is the factory |
| `package.json` | `omp.extensions` (`./extensions/autocompacter.ts`) is how omp loads it; `files` whitelists the publish payload; `packageManager` pins pnpm; host package is a dev dep + optional peer dep |
| `tsconfig.json` | `erasableSyntaxOnly`, `verbatimModuleSyntax`, `include` = extensions + scripts |
| `pnpm-workspace.yaml` | Single-package repo; holds `allowBuilds` (`onnxruntime-node`, `protobufjs` = `false`; only types are used from the host package) and `minimumReleaseAgeExclude` for `@oh-my-pi/*@18.4.10` |
| `pnpm-lock.yaml` | Must match `package.json` — CI uses `--frozen-lockfile` |
| `.github/workflows/ci.yml` | push to `main` / PR / manual: install → typecheck → test (Node 24) |
| `.github/workflows/publish.yml` | Release published (or manual with `tag` input): checks tag == `v<package.json version>` and tag commit == HEAD, then typecheck + test + `pnpm publish --no-git-checks` to `npm.pkg.github.com` with `GITHUB_TOKEN` |
| `scripts/smoke-rpc.ts` | End-to-end check against a real `omp` |
| `CHANGELOG.md`, `README.md` | User-facing docs (see sync table) |

## Runtime/Tooling Preferences

- **pnpm only** — no npm/npx/yarn/bun/bunx. `packageManager: pnpm@11.15.1`; CI reads it via `pnpm/action-setup` (no `version` input).
- **Node ≥ 24** (≥ 23.6 minimum for type-stripping). No transpiler — don't add one.
- Zero runtime dependencies. `@oh-my-pi/pi-coding-agent` is imported with `import type` only.
- pnpm 11 blocks dependency build scripts by default; if install fails with `ERR_PNPM_IGNORED_BUILDS`, set the package to `false` in `pnpm-workspace.yaml` `allowBuilds`.

## Testing & QA

- Framework: `node:test` + `node:assert/strict`. Tests are **not typechecked** (outside `tsconfig` `include`).
- `tests/autocompacter.test.ts` — `makeHarness({ configPath?, branch?, usage?, agentKind? })` builds a fake `pi` (records `handlers`, `commands`, `appended`; `appendEntry` also pushes into `branch`) and fake `ctx` (`getContextUsage`, `compact` returning the controllable `h.compactResult`, `ui.notify` log, `sessionManager.getBranch`). Pass `usage: undefined` explicitly to simulate unavailable usage (the harness checks `"usage" in opts`).
- Helpers: `run(h, "args")` (command handler), `end(h, { willContinue? })` (fires `agent_end` then flushes one `setImmediate` tick), `start(h)` (`session_start`), `usageOf(tokens, window?)`, `lastNotify(h)`. To simulate a new session, build a second harness with the first one's `branch` and call `start`.
- Isolation: a temp root created at module load, one unique config path per harness (`freshConfigPath()`), removed in `after`. Never touch the real agent dir. Fully offline.
- Covered (22 tests): token parsing, off-by-default, threshold boundary (249,999 vs 250,000), type → compact options, every guard, rejection + `inFlight` release, session snapshot/restore/reset, global write/precedence/reset/write-failure, invalid and unparseable config warnings, status output.
- Not covered by unit tests: real host behavior (`agent_end` timing, real `compact`) — that is `pnpm smoke`'s job; argument-completion output.
- New tests should assert behavior (thresholds, precedence, guards, persistence), not message wording beyond essential fragments. Run one with `--test-name-pattern`.
- No coverage tooling or threshold.

## Documentation Sync

| Change | Update |
| --- | --- |
| Any user-visible change | `CHANGELOG.md` → `## [Unreleased]` (Keep a Changelog) |
| Command, config keys, defaults, install | `README.md` |
| Architecture, guards, conventions, tooling | this file |

## Smoke-testing against real omp

`pnpm smoke` spawns `omp --mode rpc --no-session --no-extensions -e extensions/autocompacter.ts --tools read --yolo` against a **temp agent dir** (never the live one). Credentials (`agent.db*`, `models.db*`, `config.yml`) are copied from `OMP_SMOKE_SOURCE_AGENT_DIR` or `~/.omp/agent`; `OMP_BIN` overrides the binary. Config written: `{enabled: true, thresholdTokens: 1000, type: "soft"}`. It parses JSONL frames, disables built-in compaction via RPC `set_auto_compaction`, then checks **A** `/autocompacter status`; **B** a prompt reading three ~45 KB files yields `compacting (soft)` then `compacted X → Y tokens`; **C** `get_messages` contains a `compactionSummary`; **D** `/autocompacter off` answers `off (session)`. Prints `PASS`/`FAIL` per check; exit 0 only if all four pass. Temp dirs are removed in `finally`. Needs working model credentials, so it is not run in CI.

## Release

1. Bump `package.json` version; `pnpm install` to sync `pnpm-lock.yaml`; move CHANGELOG entries under the new version.
2. Commit `chore(release): bump version to X.Y.Z`; annotated tag `vX.Y.Z`; push the tag.
3. `gh release create vX.Y.Z --verify-tag --notes-file <notes>` → `publish.yml` validates and publishes. The `gh` token lacks `read:packages`, so verify via the publish run log (`@frapetti-dev/autocompacter@X.Y.Z`), not the packages API.
