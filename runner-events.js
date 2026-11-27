/**
 * Helpers for parsing Pi JSON mode events and summarizing subagent results.
 */

function getSeenMessageSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenMessageSignatures")) {
    Object.defineProperty(result, "__seenMessageSignatures", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenMessageSignatures;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

function getMessageSignature(message) {
  return stableStringify(message);
}

function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function addAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;

  updateAssistantMetadata(result, message);

  const signature = getMessageSignature(message);
  const seen = getSeenMessageSignatures(result);
  if (seen.has(signature)) return false;
  seen.add(signature);

  result.messages.push(message);

  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }

  return true;
}

function addAssistantMessages(result, messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addAssistantMessage(result, message)) changed = true;
  }
  return changed;
}

export function processPiEvent(event, result) {
  if (!event || typeof event !== "object") return false;

  // Check max turns limit before processing new events
  if (result.maxTurnsBudget && result.usage.turns >= result.maxTurnsBudget) {
    result.maxTurns = true;
    result.stopReason = "max_turns";
    result.errorMessage = `Sub-agent exceeded maximum turns (${result.maxTurnsBudget})`;
    // Preserve accumulated child stderr; only set the fallback if empty.
    if (!result.stderr.trim()) result.stderr = `Sub-agent exceeded maximum turns (${result.maxTurnsBudget})`;
    return false;
  }

  // Block sub-agents from spawning further sub-agents
  // This is enforced at the runner level (not via system prompt) for reliability
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const content = event.message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "toolCall" && part?.name === "subagent") {
          result.stopReason = "subagent_recursion_blocked";
          result.errorMessage = "Sub-agents are not allowed to spawn further sub-agents.";
          result.stderr = result.errorMessage;
          result.exitCode = 1;
          return false;
        }
      }
    }
  }

  switch (event.type) {
    case "message_end":
      return addAssistantMessage(result, event.message);

    case "turn_end":
      return addAssistantMessage(result, event.message);

    case "agent_end":
      result.sawAgentEnd = true;
      return addAssistantMessages(result, event.messages);

    case "compaction_start":
      result.compactionStarted = (result.compactionStarted || 0) + 1;
      return true;

    case "compaction_end":
      if (!event.aborted && !event.errorMessage) {
        result.compactionCompleted = (result.compactionCompleted || 0) + 1;
      }
      return true;

    default:
      return false;
  }
}

export function processPiJsonLine(line, result) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  return processPiEvent(event, result);
}

export function getFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        return part.text;
      }
    }
  }

  return "";
}

export function getResultSummaryText(result) {
  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) {
    if (result?.stopReason === "length") {
      return `${finalText}\n\n[final message truncated: model hit output token limit]`;
    }
    return finalText;
  }

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  const isError =
    (typeof result?.exitCode === "number" && result.exitCode > 0) ||
    result?.stopReason === "error" ||
    result?.stopReason === "aborted";

  if (isError && typeof result?.stderr === "string" && result.stderr.trim()) {
    return result.stderr.trim();
  }

  return "(no output)";
}

/**
 * A short, single-line description of a tool-call block for failure reports.
 * Args are JSON-stringified and truncated so a large `write`/`edit` payload
 * does not drown out the rest of the activity log.
 */
function summarizeToolCall(part) {
  const name = part?.name || part?.toolName || "?";
  let brief;
  try {
    brief = JSON.stringify(part?.arguments ?? part?.args ?? {});
  } catch {
    brief = "{...}";
  }
  if (brief.length > 120) brief = `${brief.slice(0, 117)}...`;
  return `${name}(${brief})`;
}

/**
 * The last `limit` tool calls the sub-agent made, in order, as numbered lines.
 * Empty string when the sub-agent made no tool calls.
 */
function recentToolCalls(messages, limit = 8) {
  if (!Array.isArray(messages)) return "";
  const calls = [];
  for (const message of messages) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && typeof part === "object" && part.type === "toolCall") {
        calls.push(summarizeToolCall(part));
      }
    }
  }
  if (calls.length === 0) return "";
  const skipped = Math.max(0, calls.length - limit);
  const shown = calls.slice(-limit);
  const lines = [];
  if (skipped > 0) lines.push(`  ... ${skipped} earlier tool call${skipped === 1 ? "" : "s"} omitted`);
  for (let i = 0; i < shown.length; i++) {
    lines.push(`  ${i + 1 + skipped}. ${shown[i]}`);
  }
  return lines.join("\n");
}

/**
 * The last few non-empty stderr lines, truncated, so a verbose child log does
 * not drown the failure report. stderr is often the only signal when the
 * sub-agent produced no assistant output (e.g. a stalled model server).
 */
function lastStderrLines(stderr, maxLines = 8, maxChars = 800) {
  if (!stderr) return "";
  const lines = stderr.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const shown = lines.slice(-maxLines);
  let joined = shown.join("\n");
  if (joined.length > maxChars) joined = `${joined.slice(0, maxChars - 3)}...`;
  if (lines.length > shown.length) {
    const omitted = lines.length - shown.length;
    joined = `... ${omitted} earlier line${omitted === 1 ? "" : "s"} omitted\n${joined}`;
  }
  return joined;
}

/**
 * Rich failure report for the parent: the reason, the turn count, the last
 * few tool calls, any partial final output, and — when the child produced no
 * assistant output — its stderr and a state hint. Used for the tool result
 * when a sub-agent did not complete, so the parent can decide whether to
 * retry with a narrower task instead of seeing only "timed out".
 *
 * `getResultSummaryText` is unchanged (it stays terse for the TUI and for
 * tests); this is the parent-facing detail.
 */
export function getFailureSummary(result) {
  const reason =
    (typeof result?.errorMessage === "string" && result.errorMessage.trim()) ||
    (typeof result?.stderr === "string" && result.stderr.trim()) ||
    (result?.stopReason ? `stop reason: ${result.stopReason}` : null) ||
    "Sub-agent failed.";

  const turns = result?.usage?.turns ?? 0;
  const finalText = getFinalAssistantText(result?.messages);
  const recent = recentToolCalls(result?.messages, 8);
  const stderrStr = typeof result?.stderr === "string" ? result.stderr.trim() : "";

  const parts = [reason.trim(), `turns: ${turns}`];

  // Genuine no-output stall: the child never produced an assistant turn. Give
  // the parent a state hint so it is not left with only "timed out, turns: 0".
  if (turns === 0 && !finalText && !recent) {
    parts.push(
      result?.compactionStarted
        ? "stopped during context compaction (no assistant output captured)"
        : "no assistant output captured (child stalled before its first response)",
    );
  }

  if (recent) parts.push(`recent activity:\n${recent}`);
  if (finalText) parts.push(`last output:\n${finalText}`);

  // Surface the child's stderr when it carries information beyond the reason
  // line (connection errors, compaction logs). Skipped when stderr is empty or
  // already the reason text (e.g. a bare timeout with no child stderr).
  if (stderrStr && stderrStr !== reason.trim()) {
    const tail = lastStderrLines(result.stderr);
    if (tail) parts.push(`stderr:\n${tail}`);
  }

  return parts.join("\n\n");
}
