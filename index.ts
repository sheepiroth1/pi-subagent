/**
 * Pi Subagent Extension — local-LLM / KV-cache friendly, with context anchors.
 *
 * Fork of clanker-wanker/pi-subagent (itself a fork of mjakl/pi-subagent).
 *
 * - Sub-agents run in isolated `pi` processes with the parent's exact system
 *   prompt, tools and model, so the prompt prefix stays byte-identical.
 * - `inherit_context` chooses what the child inherits: the current branch
 *   (default), nothing, a named anchor, or any entry id in the session tree.
 * - `context_anchor` saves / lists / deletes named anchors (session labels
 *   `anchor:<name>`, visible in /tree). Children that share an anchor share a
 *   stable prefix → KV / prompt cache hits.
 * - In the child, the task is delivered as a tool result (see delivery.ts) so
 *   chat templates render the inherited history exactly as in the parent.
 * - Sub-agents cannot spawn further sub-agents (enforced at runner level).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type SessionView,
	ANCHOR_LABEL_PREFIX,
	ANCHOR_NAME_RE,
	anchorPointForSave,
	findAnchor,
	listAnchors,
	parseInheritTarget,
	resolveInherit,
	toSessionJsonl,
} from "./anchors.ts";
import { CHILD_ENV, DELIVERY_ENV, applyTaskDelivery, resolveDelivery } from "./delivery.ts";
import { renderCall, renderResult } from "./render.ts";
import { getResultSummaryText } from "./runner-events.js";
import { acquireSlot, releaseSlot } from "./queue.ts";
import { runAgent } from "./runner.ts";
import { type SingleResult, isResultError, resolveSubagentConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Constant sub-agent instructions appended to the system prompt in parent
 * and child alike. Deterministic text → stable prefix.
 */
const SUBAGENT_INSTRUCTIONS = `
## Sub-Agent Tools/Extension

Sub-agents run on the same local model, with this same system prompt. You may therefore switch between main-agent and sub-agent mode within one conversation.

You are in sub-agent mode when the most recent \`subagent\` tool call has a result that starts with:

\`\`\`
**[BEGIN SUB AGENT MODE]**
\`\`\`

Then you ARE that sub-agent: complete the task in that result and finish with a final message; that message is returned to the main agent as the tool's result. In sub-agent mode you cannot spawn sub-agents. Ignore earlier identities, tasks and plans in the history that are not part of your task.

### When to Use a Sub-Agent

- Heavy research across many files without polluting your context
- Long-running tasks that would consume your context window
- Several independent tasks that need the same background material
- Consolidating knowledge into a summary before it comes back to you

### What a Sub-Agent Sees (inherit_context)

- omitted / "current": the full conversation up to your \`subagent\` call. It knows exactly what you know.
- "<anchor name>": the conversation up to an anchor saved with \`context_anchor\`. Every sub-agent started from the same anchor shares that exact history, so the inference cache is reused.
- "none": no conversation history, only the system prompt and the task.
- an entry id from the session tree: the conversation up to that entry.

### Anchor Workflow

1. Read the material every sub-agent needs (spec, docs, skills) into the conversation.
2. \`context_anchor({ action: "save", name: "spec" })\` — the anchor is the conversation before this call.
3. Start sub-agents with \`inherit_context: "spec"\` and a self-contained task. Anything after the anchor is not visible to them.

\`\`\`
subagent({ name: "researcher", task: "...", inherit_context: "spec" })
\`\`\`

### Best Practices

1. Give sub-agents clear, specific task descriptions
2. Long-running tasks: raise PI_SUBAGENT_TIMEOUT before delegating
3. Let sub-agents write results to files — you can read them back
4. Use sub-agents to consolidate knowledge into summaries before bringing it back into your context
`;

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	name: Type.String({
		description: "A human-like name for the sub-agent (e.g., 'researcher', 'analyst', 'Ada'). Display only.",
	}),
	task: Type.String({
		description: "Self-contained task description.",
	}),
	inherit_context: Type.Optional(
		Type.String({
			description:
				'What conversation the sub-agent inherits: "current" (default, everything so far), "none", an anchor name saved with context_anchor, or a session entry id. Reusing one anchor for many sub-agents reuses the inference cache.',
		}),
	),
});

const AnchorParams = Type.Object({
	action: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("delete")], {
		description: "save: anchor the conversation as it was before this call. list: show anchors. delete: remove an anchor.",
	}),
	name: Type.Optional(
		Type.String({ description: "Anchor name (letters, digits, . _ -). Required for save and delete." }),
	),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(value: string, isError = false) {
	return { content: [{ type: "text" as const, text: value }], details: {}, ...(isError ? { isError: true } : {}) };
}

function errorResult(message: string, results: SingleResult[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { results } as any,
		isError: true,
	};
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const isChild = process.env[CHILD_ENV] === "1";

	// Same constant text in parent and child → identical system prompt.
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: event.systemPrompt + SUBAGENT_INSTRUCTIONS,
	}));

	// Child only: deliver the task as a tool result (see delivery.ts).
	if (isChild) {
		const delivery = resolveDelivery(process.env[DELIVERY_ENV]);
		pi.on("context", async (event, ctx) => {
			const model = ctx.model as { api?: string; provider?: string; id?: string } | undefined;
			const messages = applyTaskDelivery(event.messages as any[], delivery, model);
			return messages === event.messages ? undefined : { messages };
		});
	}

	// -----------------------------------------------------------------------
	// context_anchor
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "context_anchor",
		label: "Context anchor",
		description: [
			"Save, list or delete named context anchors for sub-agents.",
			"save: anchors the conversation as it was right before this call (everything read so far).",
			'Sub-agents started with subagent({ inherit_context: "<name>" }) inherit exactly that conversation, so many sub-agents can share one cached prefix.',
		].join("\n"),
		parameters: AnchorParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sm = ctx.sessionManager as unknown as SessionView;
			try {
				if (params.action === "list") {
					const anchors = listAnchors(sm);
					if (anchors.length === 0) return text("No anchors saved.");
					const lines = anchors.map(
						(a) =>
							`- ${a.name}: entry ${a.entryId}, ${a.depth} entries, ~${a.approxTokens} tokens${a.onCurrentBranch ? "" : " (other branch)"}`,
					);
					return text(`Anchors:\n${lines.join("\n")}`);
				}

				const name = params.name?.trim() ?? "";
				if (!ANCHOR_NAME_RE.test(name)) {
					return text("Anchor name required: 1-64 chars of letters, digits, '.', '_' or '-'.", true);
				}

				if (params.action === "delete") {
					const anchor = findAnchor(sm, name);
					if (!anchor) return text(`No anchor named "${name}".`, true);
					pi.setLabel(anchor.entryId, undefined);
					return text(`Deleted anchor "${name}" (entry ${anchor.entryId}).`);
				}

				// save
				const entryId = anchorPointForSave(sm);
				const previous = findAnchor(sm, name);
				if (previous && previous.entryId !== entryId) pi.setLabel(previous.entryId, undefined);
				pi.setLabel(entryId, `${ANCHOR_LABEL_PREFIX}${name}`);
				const info = findAnchor(sm, name);
				return text(
					`Saved anchor "${name}" at entry ${entryId}` +
						(info ? ` (${info.depth} entries, ~${info.approxTokens} tokens)` : "") +
						`. Use subagent({ ..., inherit_context: "${name}" }).`,
				);
			} catch (err) {
				return text(err instanceof Error ? err.message : String(err), true);
			}
		},
	});

	// -----------------------------------------------------------------------
	// subagent
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a sub-agent running in an isolated pi process with your system prompt, tools and model.",
			"",
			'inherit_context picks the conversation it inherits: "current" (default), "none", an anchor name, or an entry id.',
			"",
			"Budgets (timeout, maxTurns) and working directory are set via the PI_SUBAGENT_TIMEOUT / PI_SUBAGENT_MAX_TURNS / PI_SUBAGENT_CWD environment variables.",
			"",
			'Example: { name: "researcher", task: "Summarize section 3 of the spec", inherit_context: "spec" }',
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (isChild) return errorResult("Sub-agents are not allowed to spawn further sub-agents.");

			const sm = ctx.sessionManager as unknown as SessionView;
			let snapshot: { jsonl: string; entryIds: string[] };
			let inherited: string;
			try {
				const header = sm.getHeader();
				if (!header || typeof header !== "object") throw new Error("failed to read the session header.");
				const resolution = resolveInherit(sm, parseInheritTarget(sm, params.inherit_context));
				snapshot = toSessionJsonl(header, resolution.entries);
				inherited = resolution.description;
			} catch (err) {
				return errorResult(`Cannot spawn sub-agent: ${err instanceof Error ? err.message : String(err)}`);
			}

			const cfg = resolveSubagentConfig();

			const outcome = await acquireSlot(signal);
			if (outcome === "aborted") return errorResult("Sub-agent aborted while waiting in queue.");
			if (outcome === "waited") {
				onUpdate?.({
					content: [{ type: "text", text: "(queued — waiting for a free sub-agent slot)" }],
					details: { results: [] } as any,
				});
			}

			try {
				const result = await runAgent({
					cwd: ctx.cwd,
					agentName: params.name,
					task: params.task,
					taskCwd: cfg.cwd,
					forkSessionSnapshotJsonl: snapshot.jsonl,
					parentSessionFile: ctx.sessionManager.getSessionFile(),
					parentCwd: ctx.cwd,
					snapshotEntryIds: snapshot.entryIds,
					signal,
					onUpdate,
					makeDetails: (results) => ({ results }),
					timeout: cfg.timeoutMs,
					maxTurns: cfg.maxTurns,
					selection: {
						provider: ctx.model?.provider,
						model: ctx.model?.id,
						thinking: pi.getThinkingLevel(),
					},
				});
				result.inherited = inherited;

				if (result.sessionFile) {
					pi.appendEntry("subagent_session", {
						agent: result.agent,
						task: result.task,
						inherited,
						sessionFile: result.sessionFile,
						exitCode: result.exitCode,
						usage: result.usage,
						cwd: result.childCwd,
					});
				}

				if (isResultError(result)) {
					return errorResult(`Sub-agent failed: ${getResultSummaryText(result)}`, [result]);
				}
				return {
					content: [{ type: "text" as const, text: getResultSummaryText(result) }],
					details: { results: [result] } as any,
				};
			} finally {
				releaseSlot();
			}
		},

		renderCall: (args, theme) => renderCall(args, theme as any),
		renderResult: (result, { expanded }, theme) => renderResult(result as any, expanded, theme as any),
	});
}
