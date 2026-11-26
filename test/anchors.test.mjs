import test from "node:test";
import assert from "node:assert/strict";
import {
	anchorPointForSave,
	listAnchors,
	parseInheritTarget,
	resolveInherit,
	toSessionJsonl,
	unansweredToolCalls,
} from "../anchors.ts";

// Minimal in-memory session tree with the SessionManager methods anchors.ts uses.
function makeSession(entries, leafId = entries.at(-1)?.id ?? null) {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const labels = new Map();
	const sm = {
		leafId,
		getHeader: () => ({ type: "session", version: 3, id: "s1", cwd: "/w" }),
		getLeafId: () => sm.leafId,
		getEntry: (id) => byId.get(id),
		getEntries: () => entries,
		getLabel: (id) => labels.get(id),
		getBranch(fromId = sm.leafId) {
			const path = [];
			let cur = fromId ? byId.get(fromId) : undefined;
			while (cur) {
				path.unshift(cur);
				cur = cur.parentId ? byId.get(cur.parentId) : undefined;
			}
			return path;
		},
		setLabel(id, label) {
			if (label === undefined) labels.delete(id);
			else labels.set(id, label);
		},
	};
	return sm;
}

const user = (id, parentId, text) => ({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } });
const asst = (id, parentId, calls = []) => ({
	type: "message",
	id,
	parentId,
	message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c, name: "read", arguments: {} })) },
});
const result = (id, parentId, callId) => ({ type: "message", id, parentId, message: { role: "toolResult", toolCallId: callId, content: [] } });

// u1 → a1(read c1) → r1 → a2(read c2) → r2 → a3(context_anchor c3, open)
function docsSession() {
	return makeSession([
		user("u1", null, "read the spec"),
		asst("a1", "u1", ["c1"]),
		result("r1", "a1", "c1"),
		asst("a2", "r1", ["c2"]),
		result("r2", "a2", "c2"),
		asst("a3", "r2", ["c3"]),
	]);
}

test("anchorPointForSave anchors before the executing assistant turn", () => {
	const sm = docsSession();
	assert.equal(anchorPointForSave(sm), "r2");
});

test("anchorPointForSave works when the executing turn is not yet in the session", () => {
	const sm = docsSession();
	sm.leafId = "r2";
	assert.equal(anchorPointForSave(sm), "r2");
});

test("anchorPointForSave skips sibling results already appended in the same batch", () => {
	const sm = makeSession([
		user("u1", null, "go"),
		asst("a1", "u1", ["c1", "c2"]),
		result("r1", "a1", "c1"), // sibling finished first; c2 (the save) is still open
	]);
	assert.equal(anchorPointForSave(sm), "u1");
});

test("unansweredToolCalls only looks at the trailing assistant turn", () => {
	const sm = docsSession();
	assert.deepEqual(unansweredToolCalls(sm.getBranch("a3")), ["c3"]);
	assert.deepEqual(unansweredToolCalls(sm.getBranch("r2")), []);
	assert.deepEqual(unansweredToolCalls(sm.getBranch("a2")), ["c2"]);
});

test("parseInheritTarget handles current, none, anchors and raw ids", () => {
	const sm = docsSession();
	sm.setLabel("r2", "anchor:spec");
	assert.deepEqual(parseInheritTarget(sm, undefined), { kind: "current" });
	assert.deepEqual(parseInheritTarget(sm, "current"), { kind: "current" });
	assert.deepEqual(parseInheritTarget(sm, "none"), { kind: "none" });
	assert.deepEqual(parseInheritTarget(sm, "spec"), { kind: "entry", entryId: "r2", anchorName: "spec" });
	assert.deepEqual(parseInheritTarget(sm, "anchor:spec"), { kind: "entry", entryId: "r2", anchorName: "spec" });
	assert.deepEqual(parseInheritTarget(sm, "r1"), { kind: "entry", entryId: "r1" });
	assert.throws(() => parseInheritTarget(sm, "nope"), /Known anchors: spec/);
});

test("resolveInherit returns root→anchor and rejects open tool calls", () => {
	const sm = docsSession();
	const res = resolveInherit(sm, { kind: "entry", entryId: "r2" });
	assert.deepEqual(res.entries.map((e) => e.id), ["u1", "a1", "r1", "a2", "r2"]);
	assert.throws(() => resolveInherit(sm, { kind: "entry", entryId: "a2" }), /tool calls \(c2\)/);
	assert.deepEqual(resolveInherit(sm, { kind: "none" }).entries, []);
	assert.deepEqual(resolveInherit(sm, { kind: "current" }).entries.map((e) => e.id), ["u1", "a1", "r1", "a2", "r2", "a3"]);
});

test("anchors on other branches are listed and resolvable", () => {
	const sm = docsSession();
	// Branch off r1 with a different follow-up, then make it the anchor.
	const entries = sm.getEntries();
	entries.push(user("u2", "r1", "alternative"));
	const sm2 = makeSession(entries, "a3");
	sm2.setLabel("u2", "anchor:alt");
	const [alt] = listAnchors(sm2);
	assert.equal(alt.name, "alt");
	assert.equal(alt.onCurrentBranch, false);
	assert.deepEqual(resolveInherit(sm2, parseInheritTarget(sm2, "alt")).entries.map((e) => e.id), ["u1", "a1", "r1", "u2"]);
});

test("a re-used anchor name resolves to the latest entry", () => {
	const sm = docsSession();
	sm.setLabel("r1", "anchor:spec");
	sm.setLabel("r2", "anchor:spec");
	assert.equal(parseInheritTarget(sm, "spec").entryId, "r2");
});

test("toSessionJsonl writes header + entries and returns ids", () => {
	const sm = docsSession();
	const { jsonl, entryIds } = toSessionJsonl(sm.getHeader(), sm.getBranch("r1"));
	const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines[0].type, "session");
	assert.deepEqual(entryIds, ["u1", "a1", "r1"]);
	assert.equal(lines.length, 4);
});
