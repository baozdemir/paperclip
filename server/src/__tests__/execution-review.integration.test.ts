import express from "express";
import request from "supertest";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companyMemberships, createDb, toolConnections, toolActionRequests, toolInvocations, toolPolicies, toolCatalogEntries, issueThreadInteractions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executionReviewFixture as fixture } from "./helpers/execution-review-fixture.js";

const supported = await getEmbeddedPostgresTestSupport();
const suite = supported.supported ? describe : describe.skip;
suite("mandatory production execution review", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("hex"));
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-review-");
    db = createDb(tempDb.connectionString);
  }, 30000);
  afterAll(async () => { vi.unstubAllEnvs(); await tempDb?.cleanup(); });

  it.each(["operator", "viewer"])("rejects %s before any provider side effect", async role => {
    const f = await fixture(db);
    await expect(f.gateway.executeTool({ sessionToken: f.session.token, tool: f.prod.name, parameters: f.parameters })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    await expect(f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: request!.id, actor: { userId: `${role}-user` } })).rejects.toThrow("role cannot review");
    await expect(f.gateway.declineActionRequest({ companyId: f.company.id, actionRequestId: request!.id, actor: { userId: `${role}-user` } })).rejects.toThrow("role cannot review");
    expect(f.sends).toHaveLength(0);
    expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, request!.id)))[0]!.status).toBe("pending");
  });

  it.each(["owner", "admin"])("allows %s to execute reviewed arguments once with a signed receipt", async role => {
    const f = await fixture(db);
    await expect(f.gateway.executeTool({ sessionToken: f.session.token, tool: f.prod.name, parameters: f.parameters })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    const input = { companyId: f.company.id, actionRequestId: request!.id, actor: { userId: `${role}-user` } };
    await Promise.all([f.gateway.approveActionRequest(input), f.gateway.approveActionRequest(input)]);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ tool: "run", args: f.parameters, receipt: { approved: true, actionRequestId: request!.id, companyId: f.company.id, agentId: f.agent.id } });
    expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, request!.id)))[0]!.status).toBe("executed");
    expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, request!.invocationId)))[0]!.status).toBe("succeeded");
  });

  it("requires a fresh review despite remembered trust and never offers remember permission", async () => {
    const f = await fixture(db);
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Old broad allow", policyType: "allow", priority: 1, selectors: { connectionId: f.connection.id } });
    await expect(f.gateway.executeTool({ sessionToken: f.session.token, tool: f.prod.name, parameters: f.parameters })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    await expect(f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: request!.id, rememberAction: true, actor: { userId: "owner-user" } })).rejects.toThrow("remembered permission");
    expect(f.sends).toHaveLength(0);
  });

  it("rechecks current roles after the card was issued", async () => {
    const f = await fixture(db);
    await expect(f.gateway.executeTool({ sessionToken: f.session.token, tool: f.prod.name, parameters: f.parameters })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    await db.update(companyMemberships).set({ status: "suspended" }).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, "admin-user")));
    await expect(f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: request!.id, actor: { userId: "admin-user" } })).rejects.toThrow("role cannot review");
    expect(f.sends).toHaveLength(0);
  });

  it("allows nonprod within the task with a receipt that cannot authorize production", async () => {
    const f = await fixture(db);
    await f.gateway.executeTool({ sessionToken: f.session.token, tool: f.nonprod.name, parameters: { ...f.parameters, server: "test-staging" } });
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ tool: "run_nonprod", receipt: { approved: false, actionRequestId: null } });
    expect(await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).toHaveLength(0);
  });
  it.each(["operator", "viewer", "owner", "admin"])("protects the approval role editor from %s privilege escalation", async role => {
    const f = await fixture(db);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: `${role}-user`,
      companyIds: [f.company.id], memberships: [{ companyId: f.company.id, status: "active", membershipRole: role }] } as never; next(); });
    app.use("/api", toolAccessRoutes(db)); app.use(errorHandler);
    // Even a connection manager cannot grant themselves production approval.
    const { principalPermissionGrants } = await import("@paperclipai/db");
    await db.insert(principalPermissionGrants).values({ companyId: f.company.id, principalType: "user",
      principalId: `${role}-user`, permissionKey: "tools:manage_connections", scope: null });
    const allowed = ["owner", "admin"].includes(role);
    await request(app).patch(`/api/tool-connections/${f.connection.id}`).send({ config: { ...f.connection.config,
      executionReview: { ...f.connection.config.executionReview as object, approverRoles: ["operator"] } } }).expect(allowed ? 200 : 403);
    const [saved] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    expect((saved.config.executionReview as { approverRoles: string[] }).approverRoles).toEqual(allowed ? ["operator"] : ["owner", "admin"]);
  });

  it.each(["operator", "owner", "admin"])("requires Owner/Admin when %s creates a guarded connection through either config field", async role => {
    const f = await fixture(db);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: `${role}-user`,
      companyIds: [f.company.id], memberships: [{ companyId: f.company.id, status: "active", membershipRole: role }] } as never; next(); });
    app.use("/api", toolAccessRoutes(db)); app.use(errorHandler);
    for (const field of ["config", "transportConfig"]) {
      await request(app).post(`/api/companies/${f.company.id}/tools/connections`).send({
        applicationId: f.connection.applicationId, name: `Guarded ${randomUUID()}`, transport: "mcp_remote",
        [field]: { ...f.connection.config, executionReview: { ...f.connection.config.executionReview as object, approverRoles: ["operator"] } },
      }).expect(role === "operator" ? 403 : 201);
    }
  });

  it.each(["owner", "admin"])("keeps pipeline log reads free and requires %s for each run despite broad allow", async role => {
    const f = await fixture(db);
    await db.update(toolConnections).set({ config: { ...f.connection.config, executionReview: {
      tools: ["bitbucketPipeline", ...Array.from({ length: 34 }, (_, i) => `cloud_mutation_${i}`)],
      approverRoles: ["owner", "admin"], receiptTools: [], nativeSlack: true,
      previewMode: "arguments", readActions: { bitbucketPipeline: ["list", "get", "steps", "step.get", "step.log"] },
    } } }).where(eq(toolConnections.id, f.connection.id));
    await db.insert(toolCatalogEntries).values({ companyId: f.company.id, applicationId: f.connection.applicationId,
      connectionId: f.connection.id, entryKind: "tool", name: "bitbucketPipeline", toolName: "bitbucketPipeline",
      riskLevel: "write", isWrite: true, isReadOnly: false, status: "active", versionHash: randomUUID(), schemaHash: randomUUID(),
      inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } });
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Historical broad allow", policyType: "allow", priority: 1,
      selectors: { connectionId: f.connection.id } });
    const { createToolGatewayService } = await import("../services/tool-gateway.js");
    const sends: unknown[] = [];
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "test-only-control-plane-signing-secret-value",
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init.body)); sends.push(body.params.arguments);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "provider fixture" }] } });
      } });
    const session = await gateway.createSession({ companyId: f.company.id, agentId: f.agent.id, runId: f.session.runId });
    const tool = (await gateway.listToolsForSession(session.token)).find(t => t.upstreamToolName === "bitbucketPipeline")!;
    for (const action of ["list", "get", "steps", "step.get", "step.log"]) {
      await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { action } });
    }
    expect(sends).toHaveLength(5);
    expect(await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).toHaveLength(0);
    const parameters = { action: "run", repository: "fixture", target: { ref_type: "branch", ref_name: "master" } };
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [pending] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending!.interactionId!));
    expect(interaction!.payload).toMatchObject({ toolAction: { nativeSlackApproval: true } });
    await expect(gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: pending!.id, actor: { userId: "operator-user" } })).rejects.toThrow("role cannot review");
    expect(sends).toHaveLength(5);
    const decision = { companyId: f.company.id, actionRequestId: pending!.id, actor: { userId: `${role}-user` } };
    await Promise.all([gateway.approveActionRequest(decision), gateway.approveActionRequest(decision)]);
    expect(sends).toHaveLength(6); expect(sends[5]).toEqual(parameters);
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { action: "future-mutation" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(sends).toHaveLength(6);
  });

});
