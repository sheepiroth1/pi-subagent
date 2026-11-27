import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getFinalAssistantText,
  getFailureSummary,
  getResultSummaryText,
  processPiEvent,
  processPiJsonLine,
} from "../runner-events.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeResult() {
  return {
    agent: "oracle",
    agentSource: "user",
    task: "repro",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

test("repro: captures final assistant output from agent_end after non-zero tool exit", async () => {
  const fixturePath = path.join(testDir, "fixtures", "agent-end-error-only.jsonl");
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
  const result = makeResult();

  for (const line of lines) {
    processPiJsonLine(line, result);
  }

  result.exitCode = 1;

  assert.equal(result.messages.length, 2);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(result.usage.turns, 2);
  assert.equal(
    getFinalAssistantText(result.messages),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
  assert.equal(
    getResultSummaryText(result),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
});

test("deduplicates assistant messages repeated across message_end, turn_end, and agent_end", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Still here" }],
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  };

  const result = makeResult();
  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "turn_end", message, toolResults: [] }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 1);
  assert.equal(result.usage.output, 2);
  assert.equal(result.sawAgentEnd, true);
});

test("non-zero exit code does not hide the final assistant text", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.errorMessage = "Command exited with code 1";
  result.stderr = "stderr noise that should be a fallback only";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "No matches found" }],
    timestamp: 1,
  });

  assert.equal(getResultSummaryText(result), "No matches found");
});

test("stderr remains a fallback only for error results", () => {
  const okResult = makeResult();
  okResult.exitCode = 0;
  okResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(okResult), "(no output)");

  const failedResult = makeResult();
  failedResult.exitCode = 1;
  failedResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(failedResult), "warning on stderr");
});

test("maxTurns enforcement stops processing when limit is reached", () => {
  // Use unique messages to avoid deduplication
  const makeMsg = (i) => ({
    role: "assistant",
    content: [{ type: "text", text: `Turn message ${i}` }],
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: i,
  });

  const result = makeResult();
  result.maxTurnsBudget = 3;

  // Process 3 messages (reaching the limit)
  processPiEvent({ type: "message_end", message: makeMsg(1) }, result);
  processPiEvent({ type: "message_end", message: makeMsg(2) }, result);
  processPiEvent({ type: "message_end", message: makeMsg(3) }, result);

  assert.equal(result.messages.length, 3);
  assert.equal(result.usage.turns, 3);

  // 4th message should be blocked by maxTurns
  const blocked = processPiEvent({ type: "message_end", message: makeMsg(4) }, result);
  assert.equal(blocked, false);
  assert.equal(result.messages.length, 3);
  assert.equal(result.maxTurns, true);
  assert.equal(result.stopReason, "max_turns");
  assert.equal(result.errorMessage, "Sub-agent exceeded maximum turns (3)");
});

test("marks final message truncated when model hit output token limit", () => {
  const result = makeResult();
  result.exitCode = 0;
  result.sawAgentEnd = true;
  result.stopReason = "length";
  result.messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "Summary cut off mid-sentence" }],
    },
  ];
  assert.equal(
    getResultSummaryText(result),
    "Summary cut off mid-sentence\n\n[final message truncated: model hit output token limit]",
  );
});

test("does not mark final message that ended normally", () => {
  const result = makeResult();
  result.exitCode = 0;
  result.sawAgentEnd = true;
  result.stopReason = "stop";
  result.messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "Complete summary" }],
    },
  ];
  assert.equal(getResultSummaryText(result), "Complete summary");
});

test("getFailureSummary reports reason, turns, recent tool calls and last output", () => {
  const result = makeResult();
  result.exitCode = 124;
  result.stopReason = "timeout";
  result.errorMessage = "Sub-agent timed out after 1800s";
  result.usage.turns = 3;
  result.messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "read", arguments: { file_path: "/a/spec.json" } },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "TODO" } },
        { type: "toolCall", id: "c3", name: "write", arguments: { file_path: "/a/out.md", content: "x".repeat(500) } },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Partial findings so far" }],
    },
  ];

  const summary = getFailureSummary(result);
  assert.ok(summary.startsWith("Sub-agent timed out after 1800s"), summary);
  assert.ok(summary.includes("turns: 3"), summary);
  assert.ok(summary.includes("read("), summary);
  assert.ok(summary.includes("grep("), summary);
  assert.ok(summary.includes("write("), summary);
  // Large write payload is truncated, not dumped in full.
  assert.ok(!summary.includes("x".repeat(500)), summary);
  assert.ok(summary.includes("last output:\nPartial findings so far"), summary);
});

test("getFailureSummary omits recent activity and last output when absent", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.stopReason = "max_turns";
  result.errorMessage = "Sub-agent exceeded maximum turns (100)";
  result.usage.turns = 100;
  const summary = getFailureSummary(result);
  assert.equal(
    summary,
    "Sub-agent exceeded maximum turns (100)\n\nturns: 100",
  );
});

test("getFailureSummary surfaces a state hint and stderr when the child produced no output", () => {
  const result = makeResult();
  result.exitCode = 124;
  result.stopReason = "timeout";
  result.errorMessage = "Sub-agent timed out after 1800s";
  result.usage.turns = 0;
  result.stderr = "model server: ECONNREFUSED 127.0.0.1:8080\nretrying...\nmodel server: ECONNREFUSED 127.0.0.1:8080";
  const summary = getFailureSummary(result);
  assert.ok(summary.startsWith("Sub-agent timed out after 1800s"), summary);
  assert.ok(summary.includes("turns: 0"), summary);
  assert.ok(summary.includes("no assistant output captured (child stalled before its first response)"), summary);
  // Child stderr is surfaced (not overwritten by the timeout message).
  assert.ok(summary.includes("ECONNREFUSED 127.0.0.1:8080"), summary);
  assert.ok(summary.includes("stderr:"), summary);
});

test("getFailureSummary state hint without stderr when the child was silent", () => {
  const result = makeResult();
  result.exitCode = 124;
  result.stopReason = "timeout";
  result.errorMessage = "Sub-agent timed out after 1800s";
  result.usage.turns = 0;
  // normalizeCompletedResult would fill stderr with the timeout message when
  // empty; simulate that here so the stderr block is correctly skipped as a
  // duplicate of the reason.
  result.stderr = "Sub-agent timed out after 1800s";
  const summary = getFailureSummary(result);
  assert.equal(
    summary,
    "Sub-agent timed out after 1800s\n\nturns: 0\n\nno assistant output captured (child stalled before its first response)",
  );
});
