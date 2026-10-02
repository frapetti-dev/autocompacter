# autocompacter

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) extension that compacts the session automatically when context usage crosses a token threshold.

- Off by default; threshold defaults to **250,000 tokens**.
- Runs at the end of an agent turn (`agent_end`), never mid-turn.
- Compaction type: omp's configured `compaction.methodOrder` (`default`) or a fixed `soft` / `remote` / `snapcompact`.
- Settings persist globally (a JSON file) and per session (session entries). Session overrides win.

## Install

Published on the GitHub Package Registry as `@frapetti-dev/autocompacter` (not npmjs.com). GitHub Packages requires an authenticated npm client even for public packages, so point the scope at it and supply a token with `read:packages` — add to `~/.npmrc`:

```
@frapetti-dev:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

(`GITHUB_TOKEN` here is a personal access token with `read:packages`, exported in your shell.)

```bash
# install into omp
omp plugin install npm:@frapetti-dev/autocompacter

# or try it once from a checkout
omp -e ./extensions/autocompacter.ts
```

## Usage

```
/autocompacter [status|on|off|threshold <tokens>|type <default|soft|remote|snapcompact>|reset] [--global]
```

| Command | Effect |
| --- | --- |
| `/autocompacter` or `status` | Show enabled state, threshold, type, where each value comes from, and current context usage |
| `on` / `off` | Enable / disable auto-compaction |
| `threshold <tokens>` | Set the threshold: `250000`, `250k`, `1.5M` (range 1K–10M) |
| `type <t>` | `default` (omp's `compaction.methodOrder`), `soft`, `remote`, `snapcompact` |
| `reset` | Clear this session's overrides |
| `reset --global` | Delete the global config file |

Without `--global` a change applies to the current session only (stored in the session, restored on resume, branch, and tree navigation). With `--global` (or `-g`) it is written to the config file and applies to every session that has no override for that key.

Shortcut: **`Alt+A`** toggles auto-compaction on/off for the current session. While it is on, the status line shows `🗜️ auto-compact @ 250K` (the trigger threshold).

### Config file

`<agentDir>/config/autocompacter.json` — default `~/.omp/agent/config/autocompacter.json` (honors `PI_CODING_AGENT_DIR`):

```json
{
	"enabled": true,
	"thresholdTokens": 200000,
	"type": "default"
}
```

All keys are optional. Invalid fields are ignored with a warning. Precedence: built-in defaults < config file < session override.

### Behavior notes

- Compaction is skipped for subagents, when the agent is about to continue its turn, while another compaction is running, and while omp's own auto-compaction is in progress.
- omp's built-in auto-compaction is not modified. If its threshold is lower than yours, it fires first.
- A threshold at or above the model's context window never fires; `status` warns about it.
- At most one compaction runs per finished turn. If the compacted context is still above the threshold, the next turn compacts again.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm smoke   # real omp over RPC; needs model credentials
```

## License

MIT
