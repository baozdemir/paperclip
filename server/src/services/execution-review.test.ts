import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { executionReceipt, executionReceiptKey, executionReview, executionReviewPreview, executionReviewSections, requiresIndividualExecutionReview } from "./execution-review.js";
import { projectSafeChatPublicationText } from "./chat-publication-projection.js";
import { requestConfirmationPayloadSchema } from "@paperclipai/shared";

/** Review arguments whose command starts at a known offset of the preview. */
function reviewArgs(command: (start: number) => string) {
  const args = { server: "test-prod", target_revision: "rev", request_id: "id", reason: "review", command: "" };
  args.command = command(JSON.stringify(args, null, 2).indexOf('"command": "') + 12);
  return args;
}

describe("execution review configuration and receipts", () => {
  const settings = { tools: ["run"], approverRoles: ["owner", "admin"], nativeSlack: true, receiptTools: ["run", "run_nonprod"] };
  it("is opt-in and validates the panel's role configuration", () => {
    expect(executionReview({})).toBeNull();
    expect(executionReview({ executionReview: settings })).toEqual(settings);
    for (const value of [null, {}, { ...settings, approverRoles: [] }, { ...settings, approverRoles: ["viewer"] },
      { ...settings, approverRoles: ["developer"] }, { ...settings, nativeSlack: "true" }, { ...settings, tools: ["run*"] },
      { ...settings, extra: true }]) expect(() => executionReview({ executionReview: value })).toThrow();
  });
  it("creates the same HMAC/hash contract that the standalone service verifies", () => {
    const signingKey = "test-only-control-plane-signing-secret-value";
    const args = { server: "test-prod", command: "printf 'Türkçe ✓'", target_revision: "r", reason: "test" };
    const token = executionReceipt({ invocationId: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222", connectionId: "77777777-7777-4777-8777-777777777777",
      agentId: "33333333-3333-4333-8333-333333333333", issueId: "44444444-4444-4444-8444-444444444444", tool: "run",
      arguments: args, approved: true, actionRequestId: "55555555-5555-4555-8555-555555555555" }, signingKey, 1790000000);
    const [body, signature] = token.split(".");
    // The standalone service holds only the derived receipt key, never the instance secret.
    const receiptKey = createHmac("sha256", signingKey).update("paperclip.execution-receipt-key.v1").digest("hex");
    expect(executionReceiptKey(signingKey)).toBe(receiptKey);
    expect(signature).toBe(createHmac("sha256", receiptKey).update("paperclip.execution-receipt.v1:" + body!).digest("hex"));
    expect(signature).not.toBe(createHmac("sha256", signingKey).update("paperclip.execution-receipt.v1:" + body!).digest("hex"));
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
    const sorted = JSON.stringify({ command: args.command, reason: args.reason, server: args.server, target_revision: args.target_revision });
    expect(payload.argumentsHash).toBe(createHash("sha256").update(sorted).digest("hex"));
    expect(payload).toMatchObject({ approved: true, issuedAt: 1790000000, tool: "run" });
  });
  it("rejects missing receipt credentials", () => {
    expect(() => executionReceipt({ invocationId: "i", companyId: "c", connectionId: "k", agentId: "a", issueId: "t", tool: "run",
      arguments: {}, approved: true, actionRequestId: "q" }, "")).toThrow();
  });
  it("shows the entire long command as bounded literal sections, including markup and Unicode", () => {
    const args = { server: "test-prod", target_revision: "rev", request_id: "id", reason: "review",
      command: "printf '<analysis>visible</analysis> <!channel> ``` *bold*'\n# " + "😀".repeat(8000) };
    const preview = executionReviewPreview(args)!;
    expect(preview).toBeTruthy();
    const sections = executionReviewSections(preview);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every(section => section.length <= 2012)).toBe(true);
    expect(sections.join("")).not.toContain("<analysis>");
    expect(JSON.parse(sections.map(section => section.slice(8, -4)).join(""))).toEqual(args);
  });
  it("keeps every section exact when a 2000-character boundary lands on a space", () => {
    const preview = executionReviewPreview(reviewArgs(start => `${"x".repeat(1999 - start)} systemctl restart app`))!;
    expect(preview[1999]).toBe(" ");
    const sections = executionReviewSections(preview);
    for (const section of sections) expect(projectSafeChatPublicationText(section)).toBe(section);
    expect(sections.map(section => section.slice(8, -4)).join("")).toBe(preview);
  });
  it("offers no native review when a section cannot be shown exactly", () => {
    // The second section would begin with "debug …", a line the chat projection drops as log output.
    expect(executionReviewPreview(reviewArgs(start => `${"x".repeat(2000 - start)}debug mode on`))).toBeNull();
  });
  it("offers no exact review that the approval payload would reject", () => {
    const payloadPreview = requestConfirmationPayloadSchema.shape.toolAction.unwrap().shape.previewMarkdown;
    expect(payloadPreview.safeParse(executionReviewPreview(reviewArgs(() => "x".repeat(19_000)))).success).toBe(true);
    expect(executionReviewPreview(reviewArgs(() => "x".repeat(25_000)))).toBeNull();
  });
  it("does not permit native approval of a redacted or unbounded review", () => {
    const args = { server: "s", target_revision: "r", request_id: "i", reason: "r", command: "password=private-canary" };
    expect(executionReviewPreview(args)).toBeNull();
    expect(executionReviewPreview({ ...args, command: "x".repeat(100001) })).toBeNull();
    expect(executionReviewPreview({ server: "s" })).toBeNull();
  });

  it("keeps explicit mixed-tool reads free and requires review for writes or unknown actions", () => {
    const review = executionReview({ executionReview: { ...settings, tools: ["bitbucketPipeline"], receiptTools: [],
      readActions: { bitbucketPipeline: ["list", "get", "step.log"] }, previewMode: "arguments" } })!;
    for (const action of ["list", "get", "step.log"]) expect(requiresIndividualExecutionReview(review, "bitbucketPipeline", { action })).toBe(false);
    for (const parameters of [{ action: "run" }, { action: "new-write-action" }, {}, { action: ["list", "run"] }, { action: "LIST" }]) {
      expect(requiresIndividualExecutionReview(review, "bitbucketPipeline", parameters)).toBe(true);
    }
    expect(requiresIndividualExecutionReview(review, "anotherTool", { action: "run" })).toBe(false);
  });
  it("supports the complete cloud mutation catalog and rejects invalid read exceptions", () => {
    expect(executionReview({ executionReview: { ...settings, tools: Array.from({ length: 40 }, (_, i) => `cloud_${i}`) } })).toBeTruthy();
    for (const readActions of [{ unknown: ["list"] }, { run: [] }, { run: ["list"] }, { run: "list" }]) {
      expect(() => executionReview({ executionReview: { ...settings, readActions } })).toThrow();
    }
  });
  it("reviews provider arguments completely without requiring SSH-specific fields", () => {
    const args = { droplet_id: 123, action: "power_cycle", note: "<visible> <!channel> `literal`" };
    const preview = executionReviewPreview(args, "arguments")!;
    expect(JSON.parse(preview)).toEqual(args);
    expect(preview).not.toContain("<!channel>");
    expect(executionReviewPreview({ password: "private-canary" }, "arguments")).toBeNull();
  });

});
