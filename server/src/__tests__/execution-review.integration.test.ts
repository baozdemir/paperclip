import express from "express";
import request from "supertest";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companyMemberships, createDb, toolConnections, toolActionRequests, toolInvocations, toolPolicies, type Db } from "@paperclipai/db";
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

});
