// Real-omp smoke test: loads the extension into `omp --mode rpc` against a temp agent dir and
// checks status → compaction trigger → compactionSummary → off. Needs working model credentials
// (copied from OMP_SMOKE_SOURCE_AGENT_DIR or ~/.omp/agent). Not run in CI.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Setup
// ============================================================================

type Frame = Record<string, unknown>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceAgentDir = process.env.OMP_SMOKE_SOURCE_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
const ompBin = process.env.OMP_BIN ?? "omp";
const FILES = ["a.txt", "b.txt", "c.txt"];

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocompacter-smoke-agent-"));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocompacter-smoke-proj-"));

for (const name of ["agent.db", "agent.db-wal", "agent.db-shm", "models.db", "models.db-wal", "models.db-shm", "config.yml"]) {
	const src = path.join(sourceAgentDir, name);
	if (fs.existsSync(src)) fs.copyFileSync(src, path.join(agentDir, name));
}
fs.mkdirSync(path.join(agentDir, "config"), { recursive: true });
fs.writeFileSync(
	path.join(agentDir, "config", "autocompacter.json"),
	JSON.stringify({ enabled: true, thresholdTokens: 1000, type: "soft" }),
);

FILES.forEach((file, fileIdx) => {
	const lines: string[] = [];
	let size = 0;
	for (let n = 1; size < 45_000; n++) {
		const line = `file ${file[0]} line ${n}: alpha${fileIdx * 7 + n} bravo${n * 3} charlie${n * 11 + fileIdx} delta echo foxtrot`;
		lines.push(line);
		size += line.length + 1;
	}
	fs.writeFileSync(path.join(projDir, file), `${lines.join("\n")}\n`);
});

// ============================================================================
// RPC plumbing
// ============================================================================

const child = spawn(
	ompBin,
	[
		"--mode", "rpc", "--no-session", "--no-extensions",
		"-e", path.join(repoRoot, "extensions", "autocompacter.ts"),
		"--no-lsp", "--no-skills", "--no-rules", "--tools", "read", "--yolo",
	],
	{ cwd: projDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "inherit"] },
);

const frames: Frame[] = [];
const waiters = new Set<() => void>();
let exited: number | null | undefined;

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
	buffer += chunk;
	let nl: number;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		try {
			frames.push(JSON.parse(line) as Frame);
		} catch {
			// non-JSON stdout noise
		}
	}
	for (const w of [...waiters]) w();
});
child.on("exit", (code) => {
	exited = code;
	for (const w of [...waiters]) w();
});

function send(frame: Frame): void {
	child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function waitFor(predicate: (f: Frame) => boolean, timeoutMs: number, label: string): Promise<Frame> {
	const { promise, resolve, reject } = Promise.withResolvers<Frame>();
	const timer = setTimeout(() => finish(() => reject(new Error(`timeout waiting for ${label}`))), timeoutMs);
	const check = () => {
		const hit = frames.find(predicate);
		if (hit) finish(() => resolve(hit));
		else if (exited !== undefined) finish(() => reject(new Error(`omp exited (${exited}) while waiting for ${label}`)));
	};
	function finish(done: () => void): void {
		clearTimeout(timer);
		waiters.delete(check);
		done();
	}
	waiters.add(check);
	check();
	return promise;
}

function notifyContaining(...needles: string[]): (f: Frame) => boolean {
	return (f) => {
		if (f.type !== "extension_ui_request" || f.method !== "notify") return false;
		const text = JSON.stringify(f);
		return needles.every((n) => text.includes(n));
	};
}

// ============================================================================
// Checks
// ============================================================================

const results: Array<[string, string | undefined]> = [];

async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
	try {
		await fn();
		results.push([name, undefined]);
		console.log(`PASS ${name}`);
		return true;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		results.push([name, reason]);
		console.log(`FAIL ${name}: ${reason}`);
		return false;
	}
}

try {
	await waitFor((f) => f.type === "ready", 60_000, "ready");
	send({ id: "ac0", type: "set_auto_compaction", enabled: false });
	await waitFor((f) => f.id === "ac0", 60_000, "set_auto_compaction response");

	send({ id: "s1", type: "prompt", message: "/autocompacter status" });
	await check("A (status)", async () => {
		await waitFor(notifyContaining("autocompacter: on", "threshold 1K tokens", "type soft"), 60_000, "status notify");
	});

	send({
		id: "p1",
		type: "prompt",
		message: `Use the read tool to read ${FILES.join(", ")} in full, then reply with the single word: done`,
	});
	await check("B (compaction triggered)", async () => {
		const failed = notifyContaining("compaction failed");
		const outcome = await Promise.race([
			waitFor(notifyContaining("autocompacter: compacted"), 180_000, "compacted notify"),
			waitFor(failed, 180_000, "failure notify"),
		]);
		if (failed(outcome)) throw new Error(JSON.stringify(outcome));
		if (!frames.some(notifyContaining("autocompacter: context", "compacting (soft)"))) {
			throw new Error("no 'compacting (soft)' notify before completion");
		}
	});

	send({ id: "m1", type: "get_messages" });
	await check("C (compactionSummary in transcript)", async () => {
		const res = await waitFor((f) => f.id === "m1", 60_000, "get_messages response");
		const messages = (res.data as { messages?: Array<{ role?: string }> } | undefined)?.messages ?? [];
		if (!messages.some((m) => m.role === "compactionSummary")) throw new Error("no compactionSummary message");
	});

	send({ id: "s2", type: "prompt", message: "/autocompacter off" });
	await check("D (off)", async () => {
		await waitFor(notifyContaining("autocompacter: off (session)"), 60_000, "off notify");
	});
} catch (err) {
	console.log(`FAIL setup: ${err instanceof Error ? err.message : String(err)}`);
	results.push(["setup", "failed"]);
} finally {
	child.stdin.end();
	if (exited === undefined) {
		const killer = setTimeout(() => child.kill(), 15_000);
		await new Promise((r) => child.once("exit", r));
		clearTimeout(killer);
	}
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(projDir, { recursive: true, force: true });
}

const ok = results.length === 4 && results.every(([, reason]) => reason === undefined);
process.exit(ok ? 0 : 1);
