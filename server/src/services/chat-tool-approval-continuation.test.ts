import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, chatConversations, chatEndpoints, chatMessageLinks, chatPublications, companies,
  companyMemberships, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions, toolActionDeliveries,
  toolActionRequests, toolApplications, toolConnections, toolInvocations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { enqueueChatRunMilestones } from "./chat-run-publications.js";
import { resolveChatOriginPublicationBindings } from "./issues.js";

// After a person approves or rejects a tool action card in Slack, the agent continues in a run woken by the review
// result (source tool_action_review, wake key tool-action-response:<request>). That run must show the same
// "working…" progress in the card's thread as a run woken by a message, or the thread stays silent until the answer.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Tool approval continuation database unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("tool approval continuation progress", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-tool-approval-progress-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "approver", name: "Approver", email: "approver@example.test", createdAt: new Date(), updatedAt: new Date() });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(options: { wakeKey?: (requestId: string) => string } = {}) {
    const [company] = await db.insert(companies).values({ name: "Approvals", issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "approver", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Operator", adapterType: "claude_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Run uptime on production", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: "approver" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Slack", uid: randomUUID(), connectionPurpose: "channel", transport: "chat_sdk" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company.id, connectionId: connection.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agent.id, status: "active" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: company.id, endpointId: endpoint.id, issueId: issue.id, externalConversationId: "test-channel", externalThreadId: randomUUID(), externalLabel: "Ops" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "approver", body: "run uptime on production" }).returning();
    await db.insert(chatMessageLinks).values({ companyId: company.id, endpointId: endpoint.id, conversationId: conversation.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
    // The run woken by the message asked for approval and ended; its own progress was replaced by the card.
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, runtimeMode: "legacy", status: "succeeded", responsibleUserId: "approver",
      contextSnapshot: { source: "chat:slack", issueId: issue.id, endpointId: endpoint.id, wakeCommentId: comment.id },
    }).returning();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId: company.id, issueId: issue.id, kind: "request_confirmation", status: "accepted",
      sourceRunId: source.id, createdByAgentId: agent.id, resolvedByUserId: "approver", resolvedAt: new Date(), payload: { version: 1, prompt: "Approve run?" } as never,
    }).returning();
    await db.insert(chatPublications).values({ companyId: company.id, endpointId: endpoint.id, conversationId: conversation.id, issueId: issue.id,
      idempotencyKey: `interaction:${interaction.id}:${endpoint.id}`, providerMessageId: "card-message", state: "published",
      payload: { classification: "external", source: "interaction", text: "Approve run?", interactionId: interaction.id } as never,
    });
    const [invocation] = await db.insert(toolInvocations).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, runId: source.id,
      idempotencyKey: randomUUID(), toolName: "mcp.server-operations:run", policyDecision: "require_approval", status: "succeeded",
    } as never).returning();
    const [request] = await db.insert(toolActionRequests).values({ companyId: company.id, invocationId: invocation.id, issueId: issue.id, interactionId: interaction.id,
      status: "executed", canonicalArgumentsHash: "hash", canonicalArgumentsSummary: {} as never, requestedByAgentId: agent.id, decidedByUserId: "approver", decidedAt: new Date(),
    } as never).returning();
    await db.insert(toolActionDeliveries).values({ actionRequestId: request.id, companyId: company.id, issueId: issue.id, interactionId: interaction.id, deliveredAt: new Date() });
    const review = { issueId: issue.id, interactionId: interaction.id, sourceRunId: source.id, toolActionRequestIds: [request.id] };
    const [continuation] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, runtimeMode: "legacy", status: "running", responsibleUserId: "approver",
      contextSnapshot: { ...review, wakeReason: "issue_commented", source: "tool_action_review", interactionKind: "request_confirmation", interactionStatus: "accepted" },
    }).returning();
    await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "automation", reason: "issue_commented", status: "claimed", runId: continuation.id,
      idempotencyKey: (options.wakeKey ?? ((id) => `tool-action-response:${id}`))(request.id), payload: { ...review, mutation: "interaction" },
    });
    return { company, issue, endpoint, conversation, continuation };
  }

  const progressOf = (runId: string) => db.select().from(chatPublications).where(like(chatPublications.idempotencyKey, `run:${runId}:%`));

  it("shows working in the card's thread while the reviewed continuation runs", async () => {
    const f = await fixture();
    expect(await resolveChatOriginPublicationBindings(db, f.company.id, f.issue.id, f.continuation.id))
      .toEqual([expect.objectContaining({ endpointId: f.endpoint.id, conversationId: f.conversation.id })]);
    await enqueueChatRunMilestones(db);
    await enqueueChatRunMilestones(db);
    const progress = await progressOf(f.continuation.id);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ conversationId: f.conversation.id, idempotencyKey: `run:${f.continuation.id}:working:${f.endpoint.id}`, payload: { progressState: "working" } });
  });

  it("publishes the failure of a reviewed continuation instead of leaving the thread silent", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed" }).where(and(eq(heartbeatRuns.id, f.continuation.id), eq(heartbeatRuns.companyId, f.company.id)));
    await enqueueChatRunMilestones(db);
    const progress = await progressOf(f.continuation.id);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ conversationId: f.conversation.id, payload: { progressState: "failed" } });
  });

  it("gives no progress to a review context without the review's own wake", async () => {
    const f = await fixture({ wakeKey: () => `tool-action-response:${randomUUID()}` });
    expect(await resolveChatOriginPublicationBindings(db, f.company.id, f.issue.id, f.continuation.id)).toEqual([]);
    await enqueueChatRunMilestones(db);
    expect(await progressOf(f.continuation.id)).toHaveLength(0);
  });
});
