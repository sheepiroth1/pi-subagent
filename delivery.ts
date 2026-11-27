/**
 * Task delivery inside the child process.
 *
 * The runner always passes the task to `pi -p` as a user message that starts
 * with TASK_MARKER. How that message reaches the model is controlled by
 * PI_SUBAGENT_TASK_DELIVERY in the child:
 *
 *   "user" — sent as-is, a new user message after the inherited history
 *            (upstream clanker-wanker behaviour).
 *
 *   "tool" — (default) rewritten in the `context` hook so the task arrives as
 *            the *result of a `subagent` tool call* instead of a new user turn.
 *
 * Why "tool": several chat templates (Qwen3 family, and others that follow its
 * pattern) render the reasoning of assistant turns only after the *last user
 * query*. Appending a user message re-renders every assistant turn since the
 * previous user message without its reasoning, so the token prefix diverges
 * from what the parent already sent and the server must reprocess it. A tool
 * result is not a user query, so the inherited history renders exactly as it
 * did in the parent.
 *
 *   inherit "current": the inherited branch ends with the parent's open
 *     `subagent` call. The task becomes that call's result — the child's prompt
 *     is token-identical to the parent's up to the result's content.
 *   inherit anchor / "none": the history ends at a clean boundary. A synthetic
 *     assistant `subagent` call (deterministic id) plus its result are added.
 *
 * The rewrite is deterministic, so every request of the child produces the
 * same prefix and the child's own turns stay cached too.
 */

export const TASK_MARKER = "[sub-agent-task] Complete this task:\n";
export const CHILD_ENV = "PI_SUBAGENT_CHILD";
export const DELIVERY_ENV = "PI_SUBAGENT_TASK_DELIVERY";
export type TaskDelivery = "user" | "tool";

export function resolveDelivery(value: string | undefined): TaskDelivery {
	return value?.trim().toLowerCase() === "user" ? "user" : "tool";
}

type Block = { type: string; [key: string]: unknown };
type Msg = { role: string; content?: unknown; [key: string]: unknown };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is Block => !!b && typeof b === "object" && (b as Block).type === "text")
		.map((b) => String(b.text ?? ""))
		.join("");
}

function hash(text: string): string {
	// FNV-1a 32-bit, hex. Only needs to be deterministic.
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

export function taskResultText(task: string): string {
	return (
		"[SUB AGENT MODE]\n" +
		"You are now the sub-agent started by this call. Complete the task below; your final message is returned to the main agent as this tool's result.\n\n" +
		`Task:\n${task}`
	);
}

/**
 * Rewrite the first TASK_MARKER user message. Returns the original array when
 * there is nothing to do (no marker, or delivery is "user").
 */
export function applyTaskDelivery<T extends Msg>(
	messages: T[],
	delivery: TaskDelivery,
	model?: { api?: string; provider?: string; id?: string },
): T[] {
	if (delivery !== "tool") return messages;
	const index = messages.findIndex((m) => m.role === "user" && textOf(m.content).startsWith(TASK_MARKER));
	if (index < 0) return messages;

	const userMsg = messages[index];
	const task = textOf(userMsg.content).slice(TASK_MARKER.length);
	const timestamp = (userMsg.timestamp as number | undefined) ?? 0;
	const before = messages.slice(0, index);
	const after = messages.slice(index + 1);

	// Case 1: an open `subagent` tool call directly precedes the task (inherit "current").
	const prev = before.at(-1);
	if (prev && prev.role === "assistant" && Array.isArray(prev.content)) {
		const answered = new Set(
			messages.filter((m) => m.role === "toolResult").map((m) => String(m.toolCallId)),
		);
		const open = (prev.content as Block[]).filter((b) => b?.type === "toolCall" && !answered.has(String(b.id)));
		const call = open.find((b) => b.name === "subagent");
		if (call) {
			const results = open.map((b) => ({
				role: "toolResult",
				toolCallId: String(b.id),
				toolName: String(b.name),
				content: [{ type: "text", text: b === call ? taskResultText(task) : "Not run: the parent started a sub-agent in the same turn." }],
				isError: b !== call,
				timestamp,
			})) as unknown as T[];
			return [...before, ...results, ...after];
		}
	}

	// Case 2: clean boundary (anchor / none). Add a synthetic call + result.
	const lastAssistant = [...before].reverse().find((m) => m.role === "assistant");
	const id = `call_subagent_${hash(task)}`;
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "subagent", arguments: { name: "sub-agent", task } }],
		api: model?.api ?? lastAssistant?.api,
		provider: model?.provider ?? lastAssistant?.provider,
		model: model?.id ?? lastAssistant?.model,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	} as unknown as T;
	const result = {
		role: "toolResult",
		toolCallId: id,
		toolName: "subagent",
		content: [{ type: "text", text: taskResultText(task) }],
		isError: false,
		timestamp,
	} as unknown as T;
	return [...before, assistant, result, ...after];
}
