# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-02

### Added

- `autocompacter` omp extension: at the end of an agent turn (`agent_end`), when context usage is at or above a token threshold, the session is compacted automatically with a detached `ctx.compact()` call (never awaited inside the handler). Defaults: off, 250,000 tokens, type `default` (omp's configured `compaction.methodOrder`).
- `/autocompacter [status|on|off|threshold <tokens>|type <default|soft|remote|snapcompact>|reset] [--global]` command with argument completion; thresholds accept `250000`, `250k`, `1.5M` (1K–10M).
- Persistence: global defaults in `<agentDir>/config/autocompacter.json` (`--global`), per-session overrides stored as session entries and restored on session start/switch/branch/tree. Session overrides win over the global file, which wins over defaults. Invalid config fields are ignored with a warning.
- Guards: skips subagents, `willContinue` turns, an already running compaction, and omp's own in-progress auto-compaction; compaction failures are reported through a notification and never throw.
- `pnpm smoke`: real-omp RPC smoke test; GitHub Actions CI and a GitHub Packages publish workflow.
