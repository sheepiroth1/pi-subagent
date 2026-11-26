/**
 * Subagent session archiving.
 *
 * After a sub-agent run, its temp session file contains the inherited
 * parent prefix (byte-identical to the snapshot) followed by the
 * sub-agent's own entries. This module archives the new entries as a
 * standalone child session in the user's session store
 * (~/.pi/agent/sessions/--<encoded-cwd>--/), with a fresh session id and
 * a parentSession header pointing at the parent session file.
 *
 * The session dir path and JSONL parsing below reimplement two small,
 * stable pieces of the pi SDK natively so this module has no runtime
 * dependency on the SDK package (the repo uses type-only SDK imports).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Current pi session format version. */
const SESSION_VERSION = 3;

/** Input for archiving a sub-agent's temp session file. */
export interface ArchiveInput {
	/** Temp session file: /tmp/pi-subagent-XXXXXX/session.jsonl */
	tmpPath: string;
	/** Parent session file path; undefined for ephemeral (--no-session) parents. */
	parentSessionFile?: string;
	/** Parent process cwd; used for the archive header and target dir. */
	parentCwd: string;
	/** Ids of the snapshot entries, in order (split point for the copy range). */
	snapshotEntryIds: string[];
}

/** Result of a successful archive. */
export interface ArchiveResult {
	/** Archived session file path in the user's session store. */
	sessionFile: string;
	/** Number of new (sub-agent) entries archived. */
	entryCount: number;
	/** cwd from the temp file header (the sub-agent's own cwd). */
	childCwd: string;
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Agent config dir: $PI_CODING_AGENT_DIR (tilde-expanded) or ~/.pi/agent. */
function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return expandHome(envDir);
	return path.join(os.homedir(), ".pi", "agent");
}

/** Session dir for a cwd: <agentDir>/sessions/--<encoded-cwd>-- (created). */
function getSessionDir(cwd: string): string {
	const resolved = path.resolve(cwd);
	const encoded = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const dir = path.join(getAgentDir(), "sessions", `--${encoded}--`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

interface ParsedSession {
	header: { cwd?: unknown };
	entries: Array<{ id?: unknown }>;
}

/**
 * Parse a session JSONL file. Skips blank and malformed lines (e.g. a
 * truncated last line). Returns null when the file is missing/empty or its
 * first parsed line is not a session header.
 */
function parseSessionFile(tmpPath: string): ParsedSession | null {
	let content: string;
	try {
		content = fs.readFileSync(tmpPath, "utf8");
	} catch {
		return null;
	}
	if (!content.trim()) return null;

	let header: { cwd?: unknown } | null = null;
	const entries: Array<{ id?: unknown }> = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (!header) {
			if (obj && typeof obj === "object" && (obj as { type?: unknown }).type === "session") {
				header = obj as { cwd?: unknown };
			} else {
				return null;
			}
		} else {
			entries.push(obj as { id?: unknown });
		}
	}
	if (!header) return null;
	return { header, entries };
}

/**
 * Archive a sub-agent's new session entries as a standalone child session
 * in the user's session store.
 *
 * The archive contains a fresh header (new session id, parent cwd,
 * parentSession pointing at the parent session file) followed by the temp
 * file's entries after the last snapshot entry, verbatim. The write is
 * atomic: a staging file in the target dir (wx flag) renamed over the
 * target name.
 *
 * Returns null (and writes nothing) when the temp file is missing/empty,
 * has no session header, the snapshot split point is not found, or the
 * sub-agent produced no new entries.
 */
export function archiveSubagentSession(input: ArchiveInput): ArchiveResult | null {
	const parsed = parseSessionFile(input.tmpPath);
	if (!parsed) return null;
	const { header, entries } = parsed;

	// Split point: last entry whose id equals the last snapshot entry id.
	// An empty snapshot (inherit_context "none") means every entry is new.
	const lastSnapshotId = input.snapshotEntryIds[input.snapshotEntryIds.length - 1];
	let splitIndex = -1;
	if (lastSnapshotId !== undefined) {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].id === lastSnapshotId) {
				splitIndex = i;
				break;
			}
		}
		if (splitIndex === -1) return null;
	}

	const newEntries = entries.slice(splitIndex + 1);
	if (newEntries.length === 0) return null;

	// Fresh header: new id, parent cwd, parentSession only when known.
	const sessionId = crypto.randomUUID();
	const now = new Date().toISOString();
	const fileTimestamp = now.replace(/[:.]/g, "-");
	const newHeader: Record<string, unknown> = {
		type: "session",
		version: SESSION_VERSION,
		id: sessionId,
		timestamp: now,
		cwd: input.parentCwd,
	};
	if (input.parentSessionFile) newHeader.parentSession = input.parentSessionFile;

	// Atomic write: staging file in the target dir (wx) + rename.
	const dir = getSessionDir(input.parentCwd);
	const target = path.join(dir, `${fileTimestamp}_${sessionId}.jsonl`);
	const staging = `${target}.tmp`;
	const lines = [JSON.stringify(newHeader), ...newEntries.map((e) => JSON.stringify(e))];
	fs.writeFileSync(staging, `${lines.join("\n")}\n`, { encoding: "utf-8", flag: "wx" });
	fs.renameSync(staging, target);

	const childCwd = typeof header.cwd === "string" ? header.cwd : input.parentCwd;
	return { sessionFile: target, entryCount: newEntries.length, childCwd };
}
