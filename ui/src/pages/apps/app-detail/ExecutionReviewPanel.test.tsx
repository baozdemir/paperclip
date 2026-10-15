// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import { ExecutionReviewPanel } from "./ExecutionReviewPanel";

const update = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: { updateConnection: update } }));
let root: Root | undefined;
let container: HTMLDivElement;
function render(canConfigure: boolean, extra: Record<string, unknown> = {}) {
  const connection = { id: "test-connection", config: { url: "https://ops.example/mcp", executionReview: {
    tools: ["run", "start_job"], approverRoles: ["owner", "admin"], nativeSlack: true,
    receiptTools: ["run", "run_nonprod", "start_job", "start_job_nonprod"], ...extra,
  } } } as unknown as ToolConnection;
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  flushSync(() => root!.render(<QueryClientProvider client={queryClient}><ExecutionReviewPanel connection={connection} canConfigure={canConfigure} /></QueryClientProvider>));
}
afterEach(() => { flushSync(() => root?.unmount()); container?.remove(); update.mockReset(); });

describe("production approval role editor", () => {
  it("shows selected membership roles without offering a viewer approval", () => {
    render(true);
    const checkboxes = Array.from(container.querySelectorAll('[role="checkbox"]'));
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes.map(node => node.getAttribute("aria-checked"))).toEqual(["true", "true", "false"]);
    expect(container.textContent).not.toContain("Viewer");
  });
  it("lets administrators save roles while preserving mandatory review and receipt settings", async () => {
    update.mockResolvedValue({}); render(true);
    const operator = Array.from(container.querySelectorAll('[role="checkbox"]'))[2] as HTMLButtonElement;
    flushSync(() => operator.click());
    const save = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Save approval roles")!;
    flushSync(() => save.click());
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith("test-connection", { config: { url: "https://ops.example/mcp", executionReview: {
      tools: ["run", "start_job"], approverRoles: ["owner", "admin", "operator"], nativeSlack: true,
      receiptTools: ["run", "run_nonprod", "start_job", "start_job_nonprod"],
    } } });
  });
  it("does not allow an unprivileged panel session to submit a policy change", () => {
    render(false);
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(container.textContent).not.toContain("Save approval roles");
    expect(update).not.toHaveBeenCalled();
  });
  it("preserves provider read exceptions and exact argument reviews when saving roles", async () => {
    update.mockResolvedValue({});
    const provider = { tools: ["bitbucketPipeline"], receiptTools: [], previewMode: "arguments",
      readActions: { bitbucketPipeline: ["list", "get", "step.log"] } };
    render(true, provider);
    const save = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Save approval roles")!;
    flushSync(() => save.click());
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[1].config.executionReview).toEqual({ ...provider,
      approverRoles: ["owner", "admin"], nativeSlack: true });
  });

});
