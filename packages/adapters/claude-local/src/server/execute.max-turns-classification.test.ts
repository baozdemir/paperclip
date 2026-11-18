import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

// Tool output the agent itself printed. It carries the literal phrase the
// model-not-found detector scans for, but the provider never returned it.
const POISONED_TOOL_OUTPUT =
  'execute.ts:1199: : failed && isClaudeModelNotFoundError({ ... ? "model_not_found"';

function buildProcResult(resultEvent: Record<string, unknown>, extraStdout = "") {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      ...(extraStdout
        ? [
            JSON.stringify({
              type: "assistant",
              session_id: "claude-session-1",
              message: { content: [{ type: "text", text: extraStdout }] },
            }),
          ]
        : []),
      JSON.stringify({ type: "result", session_id: "claude-session-1", ...resultEvent }),
    ].join("\n"),
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockExecutionResult(result: ReturnType<typeof buildProcResult>) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version")
      ? { ...result, exitCode: 0, stdout: "2.1.284 (Claude Code)" }
      : result,
  );
}

function buildContext() {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local failure classification precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps max_turns_exhausted when stdout mentions model_not_found", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error_max_turns" }, POISONED_TOOL_OUTPUT),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  // A QA run's tools print "401 Unauthorized"; that is the agent's own output, not Claude asking for a login.
  it("does not report claude_auth_required for the 5-hour limit when a tool printed Unauthorized", async () => {
    mockExecutionResult(
      buildProcResult(
        { is_error: true, subtype: "success", result: "You've hit your 5-hour limit · resets 11:20am (UTC)" },
        "GET /api/admin -> HTTP/1.1 401 Unauthorized (login required)",
      ),
    );

    const result = await execute(buildContext() as never);

    // Only the wrong login label goes; how the limit itself is recognised is unchanged.
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toContain("You've hit your 5-hour limit");
  });

  it("reports claude_transient_upstream for an overload when a tool printed Unauthorized", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error_during_execution", result: "API Error: 529 overloaded" },
        "GET /api/admin -> HTTP/1.1 401 Unauthorized"),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_transient_upstream");
  });

  it("still reports claude_auth_required when Claude asks for a login", async () => {
    mockExecutionResult(buildProcResult({ is_error: true, subtype: "error", result: "Not logged in · Please run /login" }));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("still reports model_not_found when the provider returns it", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error", result: "API Error: 404 model not found" }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("model_not_found");
  });
});
