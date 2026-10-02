import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// Types & constants
// ============================================================================

export type CompactType = "default" | "soft" | "remote" | "snapcompact";
export interface Settings {
	enabled: boolean;
	thresholdTokens: number;
	type: CompactType;
}
export type SettingsOverride = Partial<Settings>;
export type Scope = "session" | "global" | "default";

export const DEFAULT_SETTINGS: Settings = { enabled: false, thresholdTokens: 250_000, type: "default" };
export const COMPACT_TYPES: readonly CompactType[] = ["default", "soft", "remote", "snapcompact"];
export const CUSTOM_TYPE = "frapetti-dev.autocompacter.settings";
export const MIN_THRESHOLD = 1_000;
export const MAX_THRESHOLD = 10_000_000;
export const USAGE =
	"Usage: /autocompacter [status|on|off|threshold <tokens>|type <default|soft|remote|snapcompact>|reset] [--global]";

const SETTING_KEYS = ["enabled", "thresholdTokens", "type"] as const;
const PREFIX = "🗜️ autocompacter:";
const STATUS_KEY = "frapetti-dev.autocompacter";
export const TOGGLE_SHORTCUT = "alt+a";

export type ParsedCommand =
	| { action: "status" }
	| { action: "set"; patch: SettingsOverride; global: boolean }
	| { action: "reset"; global: boolean };

// ============================================================================
// Pure helpers
// ============================================================================

export function parseTokenCount(text: string): number | { error: string } {
	const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text.trim());
	if (!m) return { error: `invalid token count: ${text}` };
	const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1;
	const n = Math.round(Number(m[1]) * mult);
	if (n < MIN_THRESHOLD || n > MAX_THRESHOLD) return { error: "threshold must be between 1K and 10M tokens" };
	return n;
}

export function formatTokens(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
	return String(Math.round(n));
}

/** Status-line text, or `undefined` (clears the segment) when auto-compaction is off. */
export function formatStatus(s: Settings): string | undefined {
	return s.enabled ? `🗜️ auto-compact @ ${formatTokens(s.thresholdTokens)}` : undefined;
}

export function validateOverride(raw: unknown): { override: SettingsOverride; problems: string[] } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { override: {}, problems: ["config is not a JSON object"] };
	}
	const obj = raw as Record<string, unknown>;
	const override: SettingsOverride = {};
	const problems: string[] = [];
	for (const key of Object.keys(obj)) {
		const v = obj[key];
		if (key === "enabled") {
			if (typeof v === "boolean") override.enabled = v;
			else problems.push("enabled: must be a boolean");
		} else if (key === "thresholdTokens") {
			if (typeof v === "number" && Number.isInteger(v) && v >= MIN_THRESHOLD && v <= MAX_THRESHOLD) {
				override.thresholdTokens = v;
			} else problems.push(`thresholdTokens: must be an integer between ${MIN_THRESHOLD} and ${MAX_THRESHOLD}`);
		} else if (key === "type") {
			if (typeof v === "string" && (COMPACT_TYPES as readonly string[]).includes(v)) override.type = v as CompactType;
			else problems.push(`type: must be one of ${COMPACT_TYPES.join("|")}`);
		} else problems.push(`${key}: unknown key`);
	}
	return { override, problems };
}

export function resolveSettings(global: SettingsOverride, session: SettingsOverride): Settings {
	return { ...DEFAULT_SETTINGS, ...global, ...session };
}

export function parseCommandArgs(args: string): ParsedCommand | { error: string } {
	const raw = args.trim().split(/\s+/).filter(Boolean);
	const global = raw.some((t) => t === "--global" || t === "-g");
	const tokens = raw.filter((t) => t !== "--global" && t !== "-g");
	const action = tokens[0]?.toLowerCase();
	const rest = tokens.slice(1);
	if (action === undefined || action === "status") {
		return rest.length === 0 ? { action: "status" } : { error: USAGE };
	}
	if (action === "on" || action === "off") {
		return rest.length === 0 ? { action: "set", patch: { enabled: action === "on" }, global } : { error: USAGE };
	}
	if (action === "threshold") {
		if (rest.length !== 1) return { error: USAGE };
		const n = parseTokenCount(rest[0]);
		if (typeof n !== "number") return n;
		return { action: "set", patch: { thresholdTokens: n }, global };
	}
	if (action === "type") {
		if (rest.length !== 1) return { error: USAGE };
		const t = rest[0].toLowerCase();
		if (!(COMPACT_TYPES as readonly string[]).includes(t)) {
			return { error: `unknown type ${t}; expected ${COMPACT_TYPES.join("|")}` };
		}
		return { action: "set", patch: { type: t as CompactType }, global };
	}
	if (action === "reset") return rest.length === 0 ? { action: "reset", global } : { error: USAGE };
	return { error: USAGE };
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Extension
// ============================================================================

export default function autocompacter(pi: ExtensionAPI, deps: { configPath?: string } = {}): void {
	// Per-session state: lives in the factory closure because module globals are
	// shared with subagent sessions that rebind this extension.
	let globalOverride: SettingsOverride = {};
	let sessionOverride: SettingsOverride = {};
	let inFlight = false;
	let hostCompacting = false;
	let pendingConfigWarning: string | undefined;

	// ----------------------------------------------------------------------
	// Global config file
	// ----------------------------------------------------------------------

	const agentDir =
		pi.pi?.getAgentDir?.() ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
	const configPath = deps.configPath ?? path.join(agentDir, "config", "autocompacter.json");

	function readGlobalFile(): { override: SettingsOverride; warning?: string } {
		let text: string;
		try {
			text = fs.readFileSync(configPath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { override: {} };
			return { override: {}, warning: `${PREFIX} ignoring invalid config ${configPath}: ${errMessage(err)}` };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			return { override: {}, warning: `${PREFIX} ignoring invalid config ${configPath}: ${errMessage(err)}` };
		}
		const { override, problems } = validateOverride(parsed);
		if (problems.length > 0) {
			return {
				override,
				warning: `${PREFIX} ignoring invalid config fields in ${configPath}: ${problems.join("; ")}`,
			};
		}
		return { override };
	}

	function loadGlobal(): void {
		const { override, warning } = readGlobalFile();
		globalOverride = override;
		pendingConfigWarning = warning;
	}

	function saveGlobal(patch: SettingsOverride): void {
		const merged = { ...readGlobalFile().override, ...patch };
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, `${JSON.stringify(merged, null, "\t")}\n`);
		globalOverride = merged;
	}

	loadGlobal();

	// ----------------------------------------------------------------------
	// Session overrides
	// ----------------------------------------------------------------------

	function restoreSession(ctx: ExtensionContext): void {
		sessionOverride = {};
		const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom" && e.customType === CUSTOM_TYPE) {
				sessionOverride = validateOverride(e.data).override;
				return;
			}
		}
	}

	function sourceOf(key: keyof Settings): Scope {
		if (key in sessionOverride) return "session";
		if (key in globalOverride) return "global";
		return "default";
	}

	function updateStatus(ctx: ExtensionContext): void {
		try {
			ctx.ui.setStatus(STATUS_KEY, formatStatus(resolveSettings(globalOverride, sessionOverride)));
		} catch {
			// status is cosmetic; never let it break a handler
		}
	}

	function restoreAndRefresh(ctx: ExtensionContext): void {
		restoreSession(ctx);
		updateStatus(ctx);
	}

	pi.on("session_switch", (_e, ctx) => restoreAndRefresh(ctx));
	pi.on("session_branch", (_e, ctx) => restoreAndRefresh(ctx));
	pi.on("session_tree", (_e, ctx) => restoreAndRefresh(ctx));
	pi.on("session_start", (_e: unknown, ctx: ExtensionContext) => {
		loadGlobal();
		restoreAndRefresh(ctx);
		if (pendingConfigWarning) {
			ctx.ui.notify(pendingConfigWarning, "warning");
			pendingConfigWarning = undefined;
		}
	});

	// ----------------------------------------------------------------------
	// Command
	// ----------------------------------------------------------------------

	const FIRST_WORDS = [
		{ value: "status", description: "Show current settings and context usage" },
		{ value: "on", description: "Enable auto-compaction" },
		{ value: "off", description: "Disable auto-compaction" },
		{ value: "threshold", description: "Set the token threshold (e.g. 250k)" },
		{ value: "type", description: "Set the compaction type" },
		{ value: "reset", description: "Clear session overrides (with --global: reset the config file)" },
		{ value: "--global", description: "Apply to the global config instead of this session" },
	];

	function describeChange(patch: SettingsOverride): string {
		if (patch.enabled !== undefined) return patch.enabled ? "on" : "off";
		if (patch.thresholdTokens !== undefined) return `threshold ${formatTokens(patch.thresholdTokens)} tokens`;
		return `type ${patch.type}`;
	}

	function statusText(ctx: ExtensionContext): string {
		const s = resolveSettings(globalOverride, sessionOverride);
		const usage = ctx.getContextUsage();
		const lines = [
			`${PREFIX} ${s.enabled ? "on" : "off"} · threshold ${formatTokens(s.thresholdTokens)} tokens · type ${s.type}`,
			`sources: enabled=${sourceOf("enabled")}, threshold=${sourceOf("thresholdTokens")}, type=${sourceOf("type")}`,
			usage
				? `context: ${formatTokens(usage.tokens ?? 0)} / ${formatTokens(usage.contextWindow)} tokens`
				: "context: unavailable",
		];
		if (usage && s.thresholdTokens >= usage.contextWindow) {
			lines.push(
				`⚠ threshold is above the current model window (${formatTokens(usage.contextWindow)}) — it will never trigger`,
			);
		}
		return lines.join("\n");
	}

	pi.registerCommand("autocompacter", {
		description: "Auto-compact at a token threshold: on|off|threshold <tokens>|type <mode>|reset [--global]",
		getArgumentCompletions(prefix: string) {
			const p = prefix.toLowerCase();
			let items: Array<{ value: string; label: string; description?: string }>;
			if (p.startsWith("type ")) {
				items = COMPACT_TYPES.map((t) => ({ value: `type ${t}`, label: t }));
			} else if (p.startsWith("threshold ")) {
				items = ["100k", "250k", "500k"].map((t) => ({ value: `threshold ${t}`, label: t }));
			} else {
				items = FIRST_WORDS.map((w) => ({ value: w.value, label: w.value, description: w.description }));
			}
			const matches = items.filter((i) => i.value.startsWith(p));
			return matches.length > 0 ? matches : null;
		},
		async handler(args: string, ctx) {
			const cmd = parseCommandArgs(args);
			if ("error" in cmd) {
				ctx.ui.notify(cmd.error, "error");
				return;
			}
			if (cmd.action === "status") {
				ctx.ui.notify(statusText(ctx), "info");
				return;
			}
			if (cmd.action === "set") {
				const scope = cmd.global ? "global" : "session";
				if (cmd.global) {
					try {
						saveGlobal(cmd.patch);
					} catch (err) {
						ctx.ui.notify(`${PREFIX} could not write ${configPath}: ${errMessage(err)}`, "error");
						return;
					}
				} else {
					sessionOverride = { ...sessionOverride, ...cmd.patch };
					pi.appendEntry(CUSTOM_TYPE, sessionOverride);
				}
				let msg = `${PREFIX} ${describeChange(cmd.patch)} (${scope})`;
				if (cmd.global && SETTING_KEYS.some((k) => k in cmd.patch && k in sessionOverride)) {
					msg += " — note: a session override still applies (/autocompacter reset)";
				}
				updateStatus(ctx);
				ctx.ui.notify(msg, "info");
				return;
			}
			// reset
			if (cmd.global) {
				try {
					fs.rmSync(configPath, { force: true });
				} catch (err) {
					ctx.ui.notify(`${PREFIX} could not remove ${configPath}: ${errMessage(err)}`, "error");
					return;
				}
				globalOverride = {};
				ctx.ui.notify(`${PREFIX} global config reset to defaults`, "info");
			} else {
				sessionOverride = {};
				pi.appendEntry(CUSTOM_TYPE, {});
				ctx.ui.notify(`${PREFIX} session overrides cleared`, "info");
			}
			updateStatus(ctx);
		},
	});

	// ----------------------------------------------------------------------
	// Shortcut
	// ----------------------------------------------------------------------

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Toggle autocompacter on/off for this session",
		handler(ctx: ExtensionContext) {
			const next = !resolveSettings(globalOverride, sessionOverride).enabled;
			sessionOverride = { ...sessionOverride, enabled: next };
			pi.appendEntry(CUSTOM_TYPE, sessionOverride);
			updateStatus(ctx);
			ctx.ui.notify(`${PREFIX} ${next ? "on" : "off"} (session)`, "info");
		},
	});

	// ----------------------------------------------------------------------
	// Trigger
	// ----------------------------------------------------------------------

	pi.on("auto_compaction_start", () => {
		hostCompacting = true;
	});
	pi.on("auto_compaction_end", () => {
		hostCompacting = false;
	});

	// Synchronous on purpose: handlers are limited to 30 s and compaction can take
	// longer, so compaction runs detached. Every branch of the detached chain
	// catches — an unhandled rejection would kill the session.
	pi.on("agent_end", (event: { willContinue?: boolean }, ctx: ExtensionContext) => {
		const s = resolveSettings(globalOverride, sessionOverride);
		if (!s.enabled || event.willContinue === true) return;
		if (ctx.agent?.kind === "sub" || inFlight || hostCompacting) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.tokens === undefined || usage.tokens < s.thresholdTokens) return;

		const before = usage.tokens;
		inFlight = true;
		ctx.ui.notify(
			`${PREFIX} context ${formatTokens(before)} ≥ ${formatTokens(s.thresholdTokens)} tokens — compacting (${s.type})`,
			"info",
		);
		let run: Promise<void>;
		try {
			run = ctx.compact(
				s.type === "default" ? { suppressContinuation: true } : { mode: s.type, suppressContinuation: true },
			);
		} catch (err) {
			run = Promise.reject(err);
		}
		void run
			.then(() => {
				const after = ctx.getContextUsage()?.tokens;
				ctx.ui.notify(
					`${PREFIX} compacted ${formatTokens(before)} → ${after === undefined || after === null ? "?" : formatTokens(after)} tokens`,
					"info",
				);
			})
			.catch((err: unknown) => {
				try {
					ctx.ui.notify(`${PREFIX} compaction failed — ${errMessage(err)}`, "error");
				} catch {
					// notify must never surface as an unhandled rejection
				}
			})
			.finally(() => {
				inFlight = false;
			});
	});
}
