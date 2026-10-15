import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, connectionGrants, heartbeatRuns, issues,
  toolApplications, toolConnections, toolCatalogEntries, toolConnectionInstalls,
  toolProfiles, toolProfileBindings, type Db } from "@paperclipai/db";
import { createToolGatewayService } from "../../services/tool-gateway.js";
import { initializeRunIdentity } from "../../services/run-identity.js";
import { secretService } from "../../services/secrets.js";

const bearer = "test-only-bearer-value-never-a-real-credential";

export async function executionReviewFixture(db: Db, context?: { companyId: string; agentId: string; issueId: string; runId: string }) {
  const company = context ? (await db.select().from(companies).where(eq(companies.id, context.companyId)))[0] :
    (await db.insert(companies).values({ name: "Execution review test", issuePrefix: `ER${randomUUID().slice(0, 5)}` }).returning())[0];
  const agent = context ? (await db.select().from(agents).where(eq(agents.id, context.agentId)))[0] :
    (await db.insert(agents).values({ companyId: company!.id, name: "Test agent", role: "engineer", adapterType: "process" }).returning())[0];
  const issue = context ? (await db.select().from(issues).where(eq(issues.id, context.issueId)))[0] :
    (await db.insert(issues).values({ companyId: company!.id, title: "Isolated review", status: "in_progress", assigneeAgentId: agent!.id }).returning())[0];
  const run = context ? (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId)))[0] :
    (await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id } }).returning())[0];
  if (!context) await initializeRunIdentity(db, { companyId: company!.id, runId: run!.id, issueId: issue!.id, responsibleUserId: null, cause: "company_default" });
  const [app] = await db.insert(toolApplications).values({ companyId: company!.id, name: "Isolated operations", type: "mcp_http", status: "active" }).returning();
  const config = { url: "https://8.8.8.8/mcp", executionReview: { tools: ["run"], approverRoles: ["owner", "admin"], nativeSlack: true, receiptTools: ["run", "run_nonprod"] } };
  const [connection] = await db.insert(toolConnections).values({ companyId: company!.id, applicationId: app!.id,
    name: "Operations fixture", uid: `ops/${randomUUID()}`, transport: "mcp_remote", status: "active", enabled: true,
    healthStatus: "ok", authKind: "api_key", credentialPolicy: "shared", config }).returning();
  const secret = await secretService(db).create(company!.id, { provider: "local_encrypted", name: "Fixture bearer", key: `fixture.${randomUUID()}`, value: `Bearer ${bearer}` });
  await db.update(toolConnections).set({ credentialRefs: [{ name: "Authorization", secretId: secret.id,
    version: "latest", placement: "header", key: "Authorization" }] }).where(eq(toolConnections.id, connection!.id));
  await db.insert(connectionGrants).values({ companyId: company!.id, connectionId: connection!.id, kind: "organization", status: "active", isDefault: true,
    credentialSecretRefs: [{ secretId: secret.id, configPath: "credentials.Authorization", versionSelector: "latest" }] });
  await db.insert(toolConnectionInstalls).values({ companyId: company!.id, connectionId: connection!.id, targetType: "agent", targetId: agent!.id });
  for (const name of ["run", "run_nonprod"]) await db.insert(toolCatalogEntries).values({ companyId: company!.id, applicationId: app!.id,
    connectionId: connection!.id, entryKind: "tool", name, toolName: name, title: name,
    riskLevel: "destructive", status: "active", versionHash: randomUUID(), schemaHash: randomUUID(), parametersSchema: { type: "object" } });
  const [profile] = await db.insert(toolProfiles).values({ companyId: company!.id, profileKey: randomUUID(), name: "Fixture tools", defaultAction: "allow" }).returning();
  await db.insert(toolProfileBindings).values({ companyId: company!.id, profileId: profile!.id, targetType: "agent", targetId: agent!.id });
  for (const role of ["owner", "admin", "operator", "viewer"]) await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: `${role}-user`, status: "active", membershipRole: role }).onConflictDoNothing();
  const sends: Array<{ tool: string; receipt: Record<string, unknown>; args: unknown }> = [];
  const gateway = createToolGatewayService(db, { toolActionSigningSecret: "test-only-control-plane-signing-secret-value", remoteHttpRequest: async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const token = new Headers(init.headers).get("x-paperclip-execution-receipt");
    if (!token) throw new Error("Missing execution receipt");
    const context = JSON.parse(Buffer.from(token!.split(".")[0]!, "base64url").toString());
    sends.push({ tool: body.params.name, receipt: context, args: body.params.arguments });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "fixture success" }] } });
  } });
  const session = await gateway.createSession({ companyId: company!.id, agentId: agent!.id, runId: run!.id });
  const tools = await gateway.listToolsForSession(session.token);
  const prod = tools.find(t => t.connectionId === connection!.id && t.upstreamToolName === "run")!;
  const nonprod = tools.find(t => t.connectionId === connection!.id && t.upstreamToolName === "run_nonprod")!;
  const parameters = { server: "test-prod", target_revision: "target-v1", command: "printf test", reason: "isolated test", request_id: randomUUID() };
  return { company: company!, agent: agent!, connection: connection!, gateway, session, prod, nonprod, parameters, sends };
}
