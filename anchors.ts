/**
 * Context anchors: named points in the parent session tree that a sub-agent
 * can inherit from.
 *
 * An anchor is a session entry id. Inheriting from it gives the child the
 * path root → anchor (`getBranch(anchorId)`), as raw session entries, so
 * compaction entries, branch summaries and context edits keep their meaning.
 *
 * Every child that inherits the same anchor gets the same byte-identical
 * prefix, which an inference server can serve from its prompt / KV cache.
 *
 * Anchors are stored as session labels (`anchor:<name>`), so they persist in
 * the session file, survive reloads, and show up in the `/tree` selector.
 */

export const ANCHOR_LABEL_PREFIX = "anchor:";
export const ANCHOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Minimal structural view of a session entry (avoids a hard SDK dependency). */
export interface EntryLike {
	type: string;
	id: string;
	parentId: string | null;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
	};
	[key: string]: unknown;
}

/** The read-only SessionManager methods this module needs. */
export interface SessionView {
	getHeader(): unknown;
	getLeafId(): string | null;
	getEntry(id: string): EntryLike | undefined;
	getBranch(fromId?: string): EntryLike[];
	getEntries(): EntryLike[];
	getLabel(id: string): string | undefined;
}

export interface AnchorInfo {
	name: string;
	entryId: string;
	/** Number of entries on the path root → anchor. */
	depth: number;
	/** Whether the anchor lies on the parent's current branch. */
	onCurrentBranch: boolean;
	/** Rough size of the inherited context (characters / 4). */
	approxTokens: number;
}

/** What a sub-agent inherits. */
export type InheritTarget =
	| { kind: "current" }
	| { kind: "none" }
	| { kind: "entry"; entryId: string; anchorName?: string };

export interface InheritResolution {
	/** Entries to write after the session header (may be empty). */
	entries: EntryLike[];
	/** Human-readable description for results / rendering. */
	description: string;
	/** Entry id the child inherits up to (undefined for "none"). */
	entryId?: string;
	anchorName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolCallIds(entry: EntryLike): string[] {
	if (entry.type !== "message" || entry.message?.role !== "assistant") return [];
	const content = entry.message.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall")
		.map((block) => String((block as { id?: unknown }).id));
}

function toolResultId(entry: EntryLike): string | undefined {
	if (entry.type !== "message" || entry.message?.role !== "toolResult") return undefined;
	return entry.message.toolCallId;
}

/**
 * Tool calls on the path that never got a result, in the trailing assistant
 * turn. Earlier turns are always closed by the time a later turn exists.
 */
export function unansweredToolCalls(path: readonly EntryLike[]): string[] {
	const answered = new Set(path.map(toolResultId).filter((id): id is string => id !== undefined));
	for (let i = path.length - 1; i >= 0; i--) {
		const ids = toolCallIds(path[i]);
		if (path[i].type === "message" && path[i].message?.role === "assistant") {
			return ids.filter((id) => !answered.has(id));
		}
	}
	return [];
}

function approxTokens(path: readonly EntryLike[]): number {
	let chars = 0;
	for (const entry of path) chars += JSON.stringify(entry.message ?? entry).length;
	return Math.round(chars / 4);
}

export function anchorNameFromLabel(label: string | undefined): string | undefined {
	if (!label || !label.startsWith(ANCHOR_LABEL_PREFIX)) return undefined;
	return label.slice(ANCHOR_LABEL_PREFIX.length);
}

// ---------------------------------------------------------------------------
// Anchor discovery
// ---------------------------------------------------------------------------

/** All anchors in the whole session tree (not only the current branch). */
export function listAnchors(sm: SessionView): AnchorInfo[] {
	const current = new Set(sm.getBranch().map((entry) => entry.id));
	const anchors: AnchorInfo[] = [];
	for (const entry of sm.getEntries()) {
		const name = anchorNameFromLabel(sm.getLabel(entry.id));
		if (!name) continue;
		const path = sm.getBranch(entry.id);
		anchors.push({
			name,
			entryId: entry.id,
			depth: path.length,
			onCurrentBranch: current.has(entry.id),
			approxTokens: approxTokens(path),
		});
	}
	return anchors;
}

export function findAnchor(sm: SessionView, name: string): AnchorInfo | undefined {
	// A name may be re-used; the most recently created entry wins.
	const matches = listAnchors(sm).filter((anchor) => anchor.name === name);
	return matches.at(-1);
}

/**
 * The entry a `save` call should anchor on: the state right *before* the
 * assistant turn that is executing the tool call. That point is a clean
 * boundary (user message or completed tool results), and it is exactly the
 * prompt the server just processed for this turn, so it is already cached.
 */
export function anchorPointForSave(sm: SessionView): string {
	const leafId = sm.getLeafId();
	if (!leafId) throw new Error("Session is empty; nothing to anchor.");
	const path = sm.getBranch(leafId);
	const answered = new Set(path.map(toolResultId).filter((id): id is string => id !== undefined));
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			if (toolCallIds(entry).some((id) => !answered.has(id))) {
				// The executing turn: anchor on its parent.
				if (!entry.parentId) throw new Error("Nothing before the current turn to anchor.");
				return entry.parentId;
			}
			break;
		}
	}
	return leafId;
}

// ---------------------------------------------------------------------------
// Inherit target parsing / resolution
// ---------------------------------------------------------------------------

/**
 * Parse the `inherit_context` parameter.
 *   undefined | "" | "current" → full current branch (default)
 *   "none" | "fresh"           → no history, system prompt only
 *   "<anchor name>"            → named anchor
 *   "<entry id>"               → any entry in the session tree
 */
export function parseInheritTarget(sm: SessionView, spec: string | undefined): InheritTarget {
	const value = (spec ?? "").trim();
	if (value === "" || value === "current") return { kind: "current" };
	if (value === "none" || value === "fresh") return { kind: "none" };
	const name = value.startsWith(ANCHOR_LABEL_PREFIX) ? value.slice(ANCHOR_LABEL_PREFIX.length) : value;
	const anchor = findAnchor(sm, name);
	if (anchor) return { kind: "entry", entryId: anchor.entryId, anchorName: anchor.name };
	if (sm.getEntry(value)) return { kind: "entry", entryId: value };
	const known = listAnchors(sm).map((a) => a.name);
	throw new Error(
		`inherit_context "${value}" is not "current", "none", an anchor name, or a session entry id.` +
			(known.length ? ` Known anchors: ${[...new Set(known)].join(", ")}.` : " No anchors saved yet (use context_anchor save)."),
	);
}

/** Resolve a target into the entries the child session file should contain. */
export function resolveInherit(sm: SessionView, target: InheritTarget): InheritResolution {
	if (target.kind === "none") return { entries: [], description: "none (fresh context)" };
	if (target.kind === "current") {
		// Upstream clanker-wanker behaviour: the full branch, including the
		// assistant turn that is calling `subagent` (its tool call stays open).
		return { entries: sm.getBranch(), description: "current branch", entryId: sm.getLeafId() ?? undefined };
	}
	const path = sm.getBranch(target.entryId);
	if (path.length === 0) throw new Error(`Entry ${target.entryId} not found in session.`);
	const open = unansweredToolCalls(path);
	if (open.length > 0) {
		throw new Error(
			`Cannot inherit up to entry ${target.entryId}: it ends with an assistant turn whose tool calls ` +
				`(${open.join(", ")}) have no results there. Pick the last tool result of that turn, or the entry before it.`,
		);
	}
	const label = target.anchorName ? `anchor "${target.anchorName}" (${target.entryId})` : `entry ${target.entryId}`;
	return { entries: path, description: label, entryId: target.entryId, anchorName: target.anchorName };
}

/** Serialize header + entries as a session JSONL file body. */
export function toSessionJsonl(header: unknown, entries: readonly EntryLike[]): { jsonl: string; entryIds: string[] } {
	const lines = [JSON.stringify(header)];
	const entryIds: string[] = [];
	for (const entry of entries) {
		lines.push(JSON.stringify(entry));
		if (typeof entry.id === "string") entryIds.push(entry.id);
	}
	return { jsonl: `${lines.join("\n")}\n`, entryIds };
}
