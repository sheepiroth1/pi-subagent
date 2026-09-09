import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { archiveSubagentSession } from "../merge.ts";

const VAR = "PI_CODING_AGENT_DIR";

function withEnv(value, fn) {
	const prev = process.env[VAR];
	if (value === undefined) delete process.env[VAR];
	else process.env[VAR] = value;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (prev === undefined) delete process.env[VAR];
			else process.env[VAR] = prev;
		});
}

const PARENT_CWD = "/tmp/parent-project";
const CHILD_CWD = "/tmp/child-project";
const PARENT_SESSION_FILE = "/tmp/parent-project/sessions/parent.jsonl";

function entry(id, parentId) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-08T18:44:00.000Z",
		message: { role: "user", content: `msg ${id}` },
	};
}

function tempHeader() {
	return {
		type: "session",
		version: 3,
		id: "parent-uuid",
		timestamp: "2026-09-08T18:40:22.128Z",
		cwd: CHILD_CWD,
	};
}

function writeTmpSession(lines) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, `${lines.map(JSON.stringify).join("\n")}\n`, { encoding: "utf-8" });
	return { dir, file };
}

function baseInput(tmpPath, overrides = {}) {
	return {
		tmpPath,
		parentSessionFile: PARENT_SESSION_FILE,
		parentCwd: PARENT_CWD,
		snapshotEntryIds: ["a", "b", "c"],
		...overrides,
	};
}

function readJsonl(file) {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map(JSON.parse);
}

test("happy path: archives new entries as a child session", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-"));
	const { dir, file } = writeTmpSession([
		tempHeader(),
		entry("a", null),
		entry("b", "a"),
		entry("c", "b"),
		entry("d", "c"),
		entry("e", "d"),
	]);
	try {
		await withEnv(agentDir, async () => {
			const result = archiveSubagentSession(baseInput(file));
			assert.ok(result, "expected an archive result");
			assert.equal(result.entryCount, 2);
			assert.equal(result.childCwd, CHILD_CWD);

			// Lands in the parent-cwd session dir with a fresh session id.
			const expectedDir = path.join(agentDir, "sessions", "--tmp-parent-project--");
			assert.ok(result.sessionFile.startsWith(`${expectedDir}${path.sep}`), result.sessionFile);
			assert.match(
				path.basename(result.sessionFile),
				/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/,
			);

			const lines = readJsonl(result.sessionFile);
			assert.equal(lines.length, 3); // header + 2 entries
			const header = lines[0];
			assert.equal(header.type, "session");
			assert.equal(header.version, 3);
			assert.equal(header.cwd, PARENT_CWD);
			assert.equal(header.parentSession, PARENT_SESSION_FILE);
			assert.notEqual(header.id, "parent-uuid");

			// New entries verbatim; first is an orphan root (dangling parentId).
			assert.deepEqual(lines[1], entry("d", "c"));
			assert.deepEqual(lines[2], entry("e", "d"));
			assert.ok(!lines.some((l) => l.id === "c"), "split entry must not be archived");

			// Temp file is left in place for the runner to clean up.
			assert.ok(fs.existsSync(file), "temp file must be untouched");
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("no new entries: returns null and writes nothing", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-"));
	const { dir, file } = writeTmpSession([
		tempHeader(),
		entry("a", null),
		entry("b", "a"),
		entry("c", "b"),
	]);
	try {
		await withEnv(agentDir, async () => {
			const result = archiveSubagentSession(baseInput(file));
			assert.equal(result, null);
			assert.equal(fs.existsSync(path.join(agentDir, "sessions")), false);
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("missing temp file: returns null", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-"));
	try {
		await withEnv(agentDir, async () => {
			const result = archiveSubagentSession(
				baseInput(path.join(agentDir, "nope.jsonl")),
			);
			assert.equal(result, null);
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("truncated last line: partial entry dropped, archive succeeds", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-"));
	const { dir, file } = writeTmpSession([
		tempHeader(),
		entry("a", null),
		entry("b", "a"),
		entry("c", "b"),
		entry("d", "c"),
	]);
	// Simulate a crash mid-write: append a truncated JSON line.
	fs.appendFileSync(file, '{"type":"message","id":"e","parentId":"d","t', {
		encoding: "utf8",
	});
	try {
		await withEnv(agentDir, async () => {
			const result = archiveSubagentSession(baseInput(file));
			assert.ok(result, "expected an archive result");
			assert.equal(result.entryCount, 1);
			const lines = readJsonl(result.sessionFile);
			assert.equal(lines.length, 2); // header + 1 entry
			assert.deepEqual(lines[1], entry("d", "c"));
		});
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
