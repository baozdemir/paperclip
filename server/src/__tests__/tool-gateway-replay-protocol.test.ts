import express from "express";
import request from "supertest";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import type { ToolGatewayService } from "../services/tool-gateway.js";

// Reuse the existing MCP fixture's SDK dependency rather than adding a production server dependency.
const fixtureRequire = createRequire(new URL("../../../packages/kv-demo-mcp-server/package.json", import.meta.url));
const { CallToolResultSchema } = await import(fixtureRequire.resolve("@modelcontextprotocol/sdk/types.js"));

describe("MCP gateway tool-result wire contract", () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const original = { content: JSON.stringify({ job_id: jobId }), data: { structuredContent: { job_id: jobId }, transport: "mcp_http" } };
  const replaySummary = { summary: JSON.stringify(original), sizeBytes: 200, sha256: "fixture-summary-digest" };

  it.each([
    ["completed object", "completed", original],
    ["replayed summary", "replayed", replaySummary],
    ["replay with no stored result", "replayed", null],
    ["null provider data", "completed", { content: "text result", data: null }],
    ["array provider data", "completed", { content: "text result", data: [1, 2] }],
    ["primitive provider data", "completed", { content: "text result", data: 7 }],
  ])("returns a schema-valid tools/call result for %s", async (_label, status, result) => {
    const executeTool = vi.fn().mockResolvedValue({ invocationId: "fixture-invocation", status, tool: "start_job_nonprod", result });
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes({ executeTool } as unknown as ToolGatewayService));
    const response = await request(app).post("/mcp/gateways/fixture-gateway")
      .set("Authorization", "Bearer fixture-only")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start_job_nonprod", arguments: { request_id: jobId } } });

    expect(response.status).toBe(200);
    expect(response.body.error).toBeUndefined();
    expect(CallToolResultSchema.safeParse(response.body.result).success).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(1);
    if (result === original) expect(response.body.result.structuredContent).toEqual(original.data);
    else expect(response.body.result).not.toHaveProperty("structuredContent");
    if (result === replaySummary) {
      // Replay stays a bounded/redacted summary; never invent a full result or invoke the provider again.
      const stored = JSON.parse(response.body.result.content[0].text);
      expect(JSON.parse(stored.summary).data.structuredContent.job_id).toBe(jobId);
    }
  });
});
