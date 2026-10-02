import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import autocompacter, { CUSTOM_TYPE, parseTokenCount } from "../extensions/autocompacter.ts";

// ============================================================================
// Harness
// ============================================================================

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autocompacter-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let counter = 0;
function freshConfigPath(): string {
	return path.join(tmpRoot, `cfg-${counter++}`, "autocompacter.json");
}

type Usage = { tokens: number | null; contextWindow: number; percent: number } | undefined;
type FakeCtx = Record<string, unknown>;
type FakeHandler = (event: unknown, ctx: FakeCtx) => unknown;

interface Harness {
	handlers: Record<string, FakeHandler>;
	commands: Record<string, { handler: (args: string, ctx: FakeCtx) => Promise<void>; getArgumentCompletions?: (p: string) => unknown }>;
	appended: Array<[string, unknown]>;
	branch: Array<Record<string, unknown>>;
	notifies: Array<[string, string | undefined]>;
	compactCalls: unknown[];
	compactResult: Promise<void>;
	usage: Usage;
	agentKind: "main" | "sub";
	ctx: FakeCtx;
	configPath: string;
}

function usageOf(tokens: number, contextWindow = 1_000_000): Usage {
	return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

function makeHarness(opts: { configPath?: string; branch?: Array<Record<string, unknown>>; usage?: Usage; agentKind?: "main" | "sub" } = {}): Harness {
	const h = {
		handlers: {},
		commands: {},
		appended: [],
		branch: opts.branch ?? [],
		notifies: [],
		compactCalls: [],
		compactResult: Promise.resolve(),
		usage: "usage" in opts ? opts.usage : usageOf(300_000),
		agentKind: opts.agentKind ?? "main",
		configPath: opts.configPath ?? freshConfigPath(),
	} as unknown as Harness;
	const pi = {
		on: (event: string, handler: FakeHandler) => {
			h.handlers[event] = handler;
		},
		registerCommand: (name: string, def: Harness["commands"][string]) => {
			h.commands[name] = def;
		},
		appendEntry: (customType: string, data: unknown) => {
			h.appended.push([customType, data]);
			h.branch.push({ type: "custom", customType, data });
		},
	};
	h.ctx = {
		get agent() {
			return { kind: h.agentKind };
		},
		getContextUsage: () => h.usage,
		sessionManager: { getBranch: () => h.branch },
		ui: { notify: (m: string, l?: string) => h.notifies.push([m, l]) },
		hasUI: true,
		compact: (o: unknown) => {
			h.compactCalls.push(o);
			return h.compactResult;
		},
	};
	autocompacter(pi as never, { configPath: h.configPath });
	return h;
}

async function run(h: Harness, args: string): Promise<void> {
	await h.commands.autocompacter.handler(args, h.ctx);
}

async function end(h: Harness, event: { willContinue?: boolean } = {}): Promise<void> {
	h.handlers.agent_end({ type: "agent_end", messages: [], ...event }, h.ctx);
	await tick();
}

async function start(h: Harness): Promise<void> {
	await h.handlers.session_start({ type: "session_start" }, h.ctx);
}

function lastNotify(h: Harness): string {
	return h.notifies[h.notifies.length - 1]?.[0] ?? "";
}

// ============================================================================
// Tests
// ============================================================================

describe("parseTokenCount", () => {
	it("accepts plain, k and M suffixes", () => {
		assert.equal(parseTokenCount("250k"), 250_000);
		assert.equal(parseTokenCount("1.5M"), 1_500_000);
		assert.equal(parseTokenCount("250000"), 250_000);
	});
	it("rejects out-of-range and malformed input", () => {
		assert.ok(typeof parseTokenCount("999") === "object");
		assert.ok(typeof parseTokenCount("abc") === "object");
		assert.ok(typeof parseTokenCount("20M") === "object");
	});
});

describe("defaults", () => {
	it("is off by default", async () => {
		const h = makeHarness({ usage: usageOf(300_000) });
		await end(h);
		assert.equal(h.compactCalls.length, 0);
	});
});

describe("trigger", () => {
	it("compacts at or above the threshold with default type", async () => {
		const h = makeHarness({ usage: usageOf(260_000) });
		await run(h, "on");
		await end(h);
		assert.equal(h.compactCalls.length, 1);
		assert.deepEqual(h.compactCalls[0], { suppressContinuation: true });
	});
	it("fires at exactly the threshold, not one token below", async () => {
		const h = makeHarness({ usage: usageOf(249_999) });
		await run(h, "on");
		await end(h);
		assert.equal(h.compactCalls.length, 0);
		h.usage = usageOf(250_000);
		await end(h);
		assert.equal(h.compactCalls.length, 1);
	});
	it("passes the configured mode", async () => {
		const h = makeHarness();
		await run(h, "on");
		await run(h, "type soft");
		await end(h);
		assert.deepEqual(h.compactCalls[0], { mode: "soft", suppressContinuation: true });
	});
	it("rejects an unknown type and keeps the previous one", async () => {
		const h = makeHarness();
		await run(h, "on");
		await run(h, "type bogus");
		assert.equal(h.notifies.at(-1)?.[1], "error");
		await end(h);
		assert.deepEqual(h.compactCalls[0], { suppressContinuation: true });
	});
});

describe("guards", () => {
	it("skips when the agent will continue", async () => {
		const h = makeHarness();
		await run(h, "on");
		await end(h, { willContinue: true });
		assert.equal(h.compactCalls.length, 0);
	});
	it("skips subagents", async () => {
		const h = makeHarness({ agentKind: "sub" });
		await run(h, "on");
		await end(h);
		assert.equal(h.compactCalls.length, 0);
	});
	it("skips while host auto-compaction runs and resumes after it ends", async () => {
		const h = makeHarness();
		await run(h, "on");
		h.handlers.auto_compaction_start({}, h.ctx);
		await end(h);
		assert.equal(h.compactCalls.length, 0);
		h.handlers.auto_compaction_end({}, h.ctx);
		await end(h);
		assert.equal(h.compactCalls.length, 1);
	});
	it("does not start a second compaction while one is pending", async () => {
		const h = makeHarness();
		await run(h, "on");
		const pending = Promise.withResolvers<void>();
		h.compactResult = pending.promise;
		await end(h);
		await end(h);
		assert.equal(h.compactCalls.length, 1);
		pending.resolve();
		await tick();
		await end(h);
		assert.equal(h.compactCalls.length, 2);
	});
});

describe("failure", () => {
	it("reports the error and releases the in-flight guard", async () => {
		const h = makeHarness();
		await run(h, "on");
		h.compactResult = Promise.reject(new Error("boom"));
		await end(h);
		const err = h.notifies.find(([, l]) => l === "error");
		assert.ok(err?.[0].includes("compaction failed"));
		assert.ok(err?.[0].includes("boom"));
		h.compactResult = Promise.resolve();
		await end(h);
		assert.equal(h.compactCalls.length, 2);
	});
});

describe("session persistence", () => {
	it("appends the full snapshot and restores it on session_start", async () => {
		const first = makeHarness();
		await run(first, "on");
		assert.deepEqual(first.appended[0], [CUSTOM_TYPE, { enabled: true }]);
		await run(first, "type soft");
		assert.deepEqual(first.appended[1], [CUSTOM_TYPE, { enabled: true, type: "soft" }]);

		const second = makeHarness({ branch: first.branch });
		await start(second);
		await end(second);
		assert.deepEqual(second.compactCalls[0], { mode: "soft", suppressContinuation: true });
	});
	it("reset clears the session override for later restores", async () => {
		const first = makeHarness();
		await run(first, "on");
		await run(first, "reset");
		const second = makeHarness({ branch: first.branch });
		await start(second);
		await end(second);
		assert.equal(second.compactCalls.length, 0);
	});
});

describe("global persistence", () => {
	it("writes the file, applies it in a new session, session overrides win, reset deletes it", async () => {
		const configPath = freshConfigPath();
		const a = makeHarness({ configPath });
		await run(a, "on --global");
		await run(a, "threshold 100k --global");
		assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { enabled: true, thresholdTokens: 100_000 });

		const b = makeHarness({ configPath, usage: usageOf(150_000) });
		await start(b);
		await end(b);
		assert.equal(b.compactCalls.length, 1);

		await run(b, "threshold 200k");
		await end(b);
		assert.equal(b.compactCalls.length, 1, "session threshold 200k suppresses a 150K trigger");

		await run(b, "reset --global");
		assert.equal(fs.existsSync(configPath), false);
	});
	it("warns when a global change is shadowed by a session override", async () => {
		const h = makeHarness();
		await run(h, "threshold 200k");
		await run(h, "threshold 100k --global");
		assert.ok(lastNotify(h).includes("a session override still applies"));
	});
	it("keeps in-memory settings when the config write fails", async () => {
		const blocker = path.join(tmpRoot, "blocker");
		fs.writeFileSync(blocker, "x");
		const h = makeHarness({ configPath: path.join(blocker, "sub", "autocompacter.json") });
		await run(h, "on --global");
		assert.equal(h.notifies.at(-1)?.[1], "error");
		assert.ok(lastNotify(h).includes("could not write"));
		await end(h);
		assert.equal(h.compactCalls.length, 0);
	});
});

describe("invalid global file", () => {
	it("applies valid fields and warns once about invalid ones", async () => {
		const configPath = freshConfigPath();
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ enabled: "yes", type: "soft" }));
		const h = makeHarness({ configPath });
		await start(h);
		const warnings = h.notifies.filter(([, l]) => l === "warning");
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0][0].includes("enabled"));
		await run(h, "status");
		assert.ok(lastNotify(h).includes("type soft"));
		assert.ok(lastNotify(h).includes("enabled=default"));
		await end(h);
		assert.equal(h.compactCalls.length, 0);
	});
	it("falls back to defaults with a warning on unparseable JSON", async () => {
		const configPath = freshConfigPath();
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, "{");
		const h = makeHarness({ configPath });
		await start(h);
		assert.equal(h.notifies.filter(([, l]) => l === "warning").length, 1);
		await end(h);
		assert.equal(h.compactCalls.length, 0);
	});
});

describe("status", () => {
	it("reports defaults and sources", async () => {
		const h = makeHarness();
		await run(h, "status");
		const text = lastNotify(h);
		assert.ok(text.includes("threshold 250K tokens"));
		assert.ok(text.includes("type default"));
		assert.ok(text.includes("sources: enabled=default"));
	});
	it("warns when the threshold exceeds the model window", async () => {
		const h = makeHarness({ usage: usageOf(1000, 200_000) });
		await run(h, "status");
		assert.ok(lastNotify(h).includes("⚠ threshold is above"));
	});
	it("handles unavailable usage", async () => {
		const h = makeHarness({ usage: undefined });
		await run(h, "status");
		assert.ok(lastNotify(h).includes("context: unavailable"));
	});
});
