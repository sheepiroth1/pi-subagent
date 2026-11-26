import test from "node:test";
import assert from "node:assert/strict";
import { TASK_MARKER, applyTaskDelivery, resolveDelivery, taskResultText } from "../delivery.ts";

const u = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 5 });
const a = (calls, extra = {}) => ({
	role: "assistant",
	content: [{ type: "thinking", thinking: "hmm" }, ...calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} }))],
	api: "openai-completions",
	provider: "local",
	model: "m",
	...extra,
});
const r = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }] });

test("resolveDelivery defaults to tool", () => {
	assert.equal(resolveDelivery(undefined), "tool");
	assert.equal(resolveDelivery("USER"), "user");
	assert.equal(resolveDelivery("bogus"), "tool");
});

test("user delivery leaves messages untouched", () => {
	const msgs = [u("hi"), u(`${TASK_MARKER}do it`)];
	assert.equal(applyTaskDelivery(msgs, "user"), msgs);
});

test("inherit current: the open subagent call gets the task as its result", () => {
	const parentPrefix = [u("hi"), a([["c1", "read"]]), r("c1"), a([["c2", "subagent"]])];
	const out = applyTaskDelivery([...parentPrefix, u(`${TASK_MARKER}do it`)], "tool");
	// Prefix (including the assistant turn with its reasoning) is untouched.
	assert.deepEqual(out.slice(0, 4), parentPrefix);
	assert.equal(out.length, 5);
	assert.equal(out[4].role, "toolResult");
	assert.equal(out[4].toolCallId, "c2");
	assert.equal(out[4].content[0].text, taskResultText("do it"));
	assert.equal(out.some((m) => m.role === "user" && String(m.content[0].text).startsWith(TASK_MARKER)), false);
});

test("inherit current: sibling open calls in the same batch get a 'not run' result", () => {
	const out = applyTaskDelivery([u("hi"), a([["c1", "read"], ["c2", "subagent"]]), u(`${TASK_MARKER}x`)], "tool");
	assert.deepEqual(out.slice(2).map((m) => [m.role, m.toolCallId, m.isError]), [
		["toolResult", "c1", true],
		["toolResult", "c2", false],
	]);
});

test("anchor: adds a deterministic synthetic call + result after the clean boundary", () => {
	const prefix = [u("read spec"), a([["c1", "read"]]), r("c1")];
	const out1 = applyTaskDelivery([...prefix, u(`${TASK_MARKER}task A`)], "tool", { api: "openai-completions", provider: "local", id: "m" });
	const out2 = applyTaskDelivery([...prefix, u(`${TASK_MARKER}task A`)], "tool", { api: "openai-completions", provider: "local", id: "m" });
	assert.deepEqual(out1.slice(0, 3), prefix);
	assert.equal(out1[3].role, "assistant");
	assert.equal(out1[3].content[0].type, "toolCall");
	assert.equal(out1[3].content[0].name, "subagent");
	assert.equal(out1[3].provider, "local");
	assert.equal(out1[4].role, "toolResult");
	assert.equal(out1[4].toolCallId, out1[3].content[0].id);
	assert.deepEqual(out1, out2, "same task → identical rewrite (child's own turns stay cached)");
});

test("later child turns are preserved after the rewrite", () => {
	const later = [a([["c9", "read"]]), r("c9")];
	const out = applyTaskDelivery([u("x"), u(`${TASK_MARKER}t`), ...later], "tool");
	assert.deepEqual(out.slice(-2), later);
});

test("continuation prompts are not rewritten", () => {
	const msgs = [u("x"), u("[sub-agent-task] Your previous run hit the context limit")];
	assert.equal(applyTaskDelivery(msgs, "tool"), msgs);
});
