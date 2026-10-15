import { createHash, createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companyMemberships, toolConnections, type Db } from "@paperclipai/db";
import { projectSafeChatPublicationText } from "./chat-publication-projection.js";
import { forbidden, unprocessable } from "../errors.js";

export type ExecutionReview = {
  tools: string[];
  approverRoles: Array<"owner" | "admin" | "operator">;
  nativeSlack: boolean;
  receiptTools: string[];
};

export function executionReview(config: Record<string, unknown> | null | undefined): ExecutionReview | null {
  if (config?.executionReview === undefined) return null;
  const raw = config.executionReview;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unprocessable("Invalid execution review settings");
  const value = raw as Record<string, unknown>;
  const names = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 30 && items.every(item => typeof item === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(item));
  if (Object.keys(value).some(key => !["tools", "approverRoles", "nativeSlack", "receiptTools"].includes(key))
    || !names(value.tools) || value.tools.length === 0 || !names(value.receiptTools)
    || !Array.isArray(value.approverRoles) || value.approverRoles.length === 0
    || !value.approverRoles.every(role => ["owner", "admin", "operator"].includes(String(role)))
    || typeof value.nativeSlack !== "boolean") throw unprocessable("Invalid execution review settings");
  return value as ExecutionReview;
}

export async function connectionExecutionReview(db: Db, companyId: string, connectionId: string | null) {
  if (!connectionId) return null;
  const [row] = await db.select({ config: toolConnections.config }).from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, connectionId))).limit(1);
  return row ? executionReview(row.config) : null;
}

export async function assertExecutionReviewer(db: Db, input: {
  companyId: string; connectionId: string | null; upstreamToolName: string;
  userId?: string | null; rememberAction?: boolean;
}) {
  const review = await connectionExecutionReview(db, input.companyId, input.connectionId);
  if (!review?.tools.includes(input.upstreamToolName)) return;
  if (input.rememberAction) throw forbidden("This action always requires an individual review; remembered permission is disabled");
  if (!input.userId) throw forbidden("An authenticated human reviewer is required");
  const [membership] = await db.select({ role: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships).where(and(eq(companyMemberships.companyId, input.companyId),
      eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, input.userId))).limit(1);
  if (membership?.status !== "active" || !review.approverRoles.includes(membership.role as ExecutionReview["approverRoles"][number]))
    throw forbidden("Your current company role cannot review this production action");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function executionReceipt(input: {
  invocationId: string; companyId: string; agentId: string; issueId: string; tool: string;
  arguments: unknown; approved: boolean; actionRequestId: string | null;
}, bearer: string, issuedAt = Math.floor(Date.now() / 1000)) {
  if (bearer.length < 32) throw forbidden("Execution receipts require a dedicated generated bearer");
  const { arguments: args, ...context } = input;
  const body = Buffer.from(canonical({ ...context, argumentsHash: createHash("sha256").update(canonical(args)).digest("hex"), issuedAt })).toString("base64url");
  return `${body}.${createHmac("sha256", bearer).update(body).digest("hex")}`;
}

/** Exact JSON review; escape markup so Slack cannot hide command text or emit mentions. */
export function executionReviewPreview(parameters: Record<string, unknown>): string | null {
  if (!["server", "command", "reason", "target_revision", "request_id"].every(key => typeof parameters[key] === "string")) return null;
  const text = JSON.stringify(parameters, null, 2).replace(/[<>&`]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  // Never offer a native approval of redacted or incomplete command text.
  if (text.length > 90_000 || projectSafeChatPublicationText(text) !== text) return null;
  return text;
}

export function executionReviewSections(text: string): string[] {
  const sections: string[] = [];
  let chunk = "";
  for (const point of text) {
    if (chunk.length + point.length > 2000) {
      sections.push("```json\n" + chunk + "\n```");
      chunk = "";
    }
    chunk += point;
  }
  if (chunk) sections.push("```json\n" + chunk + "\n```");
  return sections;
}

export async function canManageExecutionReview(db: Db, companyId: string, userId?: string | null) {
  if (!userId) return false;
  const [member] = await db.select({ role: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId))).limit(1);
  return member?.status === "active" && ["owner", "admin"].includes(member.role ?? "");
}
