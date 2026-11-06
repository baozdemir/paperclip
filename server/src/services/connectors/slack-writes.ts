import { notifyChatActionWork, notifyChatPublicationWork } from "../chat-work-notifications.js";
import { authorizeSlackDocument } from "./slack-document.js";
import { slackMessage } from "./slack-message.js";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  assets,
  authUsers,
  chatActions,
  chatEndpoints,
  chatEndpointResources,
  chatIdentityLinks,
  issueAttachments,
  issues,
  toolInvocations,
  type Db,
} from "@paperclipai/db";
import { SLACK_TOOLS } from "@paperclipai/shared";
import { conflict, forbidden, HttpError, unprocessable } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import {
  resolveSlackTaskAuthority,
  type SlackTaskBinding,
} from "./slack-authority.js";
import {
  authorizeSlackWrite,
  slackPublicationAllowed,
  recordSlackOriginBoundary,
} from "./slack-access.js";
import {
  slackClient,
  object,
  objects,
  type SlackObject,
} from "./slack-client.js";
import { logActivity } from "../activity-log.js";

const richText = (text: unknown) => [
  {
    type: "rich_text",
    elements: [
      { type: "rich_text_section", elements: [{ type: "text", text }] },
    ],
  },
];
export async function executeSlackWrite(
  db: Db,
  binding: SlackTaskBinding,
  name: string,
  args: SlackObject,
  invocationId: string | undefined,
  fetchImpl = fetch,
) {
  const tool = SLACK_TOOLS.find((t) => t.name === name)!;
  let authority = await resolveSlackTaskAuthority(db, binding);
  if (authority.workMode !== "standard")
    throw forbidden("Slack writes require standard work mode");
  const [invocation] = invocationId
    ? await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.companyId, binding.companyId),
            eq(toolInvocations.id, invocationId),
            eq(toolInvocations.runId, binding.runId),
            eq(toolInvocations.agentId, binding.agentId),
            eq(toolInvocations.connectionId, authority.endpoint.connectionId),
          ),
        )
    : [];
  if (
    !invocation ||
    invocation.status !== "executing" ||
    (tool.risk === "approval" && invocation.approvalState !== "approved")
  )
    throw forbidden(
      "Slack writes require a governed invocation and any required approval",
    );
  const api = slackClient(authority.botToken, fetchImpl);
  await recordSlackOriginBoundary(db, authority, api);
  if (
    name === "slack_create_channel" &&
    !(await slackPublicationAllowed(
      db,
      binding.companyId,
      authority.endpoint.id,
      binding.issueId,
      "new-channel",
      null,
    ))
  )
    throw forbidden(
      "Create channels in a separate task before reading private research; its content cannot be published to a new destination",
    );
  if (name !== "slack_create_channel" && name !== "slack_open_dm")
    await authorizeSlackWrite(db, authority, api, String(args.channel));
  if (
    name === "slack_invite" &&
    (args.users as string[]).includes(authority.endpoint.botExternalId!)
  )
    throw forbidden("The bot cannot expand its own access");
  if (name === "slack_invite" && invocation.approvalState !== "approved") {
    // Free invitations are limited to a channel this bot created itself; its
    // creation receipt is the proof (membership events rewrite resource metadata).
    const [created] = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, authority.endpoint.companyId),
          eq(chatActions.endpointId, authority.endpoint.id),
          eq(chatActions.kind, "slack_tool_write"),
          eq(chatActions.status, "processed"),
          sql`${chatActions.payload}->>'name' = 'slack_create_channel'`,
          sql`${chatActions.result}->>'channel' = ${String(args.channel)}`,
        ),
      )
      .limit(1);
    if (!created)
      throw forbidden(
        "Inviting people to a channel this bot did not create needs an approved request",
      );
  }
  const taskStart =
    name === "slack_start_task"
      ? await slackTaskStartTarget(db, authority, args)
      : null;
  const hash = createHash("sha256")
    .update(JSON.stringify({ name, args }))
    .digest("hex");
  const key = `slack-tool:${binding.issueId}:${args.idempotencyKey}`;
  const [created] = await db.transaction(async (tx) => {
    await notifyChatPublicationWork(tx);
    return tx
      .insert(chatActions)
      .values({
        companyId: binding.companyId,
        endpointId: authority.endpoint.id,
        conversationId: authority.conversation?.id ?? null,
        principalId: authority.principalId,
        kind: "slack_tool_write",
        providerActionId: key,
        status: "received",
        payload: {
          name,
          args,
          hash,
          binding,
          userId: authority.userId,
          revision: authority.revision,
          invocationId,
        },
      })
      .onConflictDoNothing()
      .returning();
  });
  const action =
    created ??
    (
      await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, authority.endpoint.id),
            eq(chatActions.providerActionId, key),
          ),
        )
    )[0]!;
  if (
    action.payload.hash !== hash ||
    action.payload.userId !== authority.userId
  )
    throw conflict(
      "Idempotency key already belongs to a different Slack operation",
    );
  if (action.status === "processed")
    return { actionId: action.id, state: "delivered", ...action.result };
  if (action.status !== "received")
    return {
      actionId: action.id,
      state: action.status,
      instruction:
        "Do not retry with another key. Inspect delivery before reconciling an uncertain result.",
    };
  const [claimed] = await db.transaction(async (tx) => {
    await notifyChatPublicationWork(tx);
    return tx
      .update(chatActions)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(eq(chatActions.id, action.id), eq(chatActions.status, "received")),
      )
      .returning();
  });
  if (!claimed) return { actionId: action.id, state: "processing" };
  try {
    authority = await resolveSlackTaskAuthority(db, binding);
    if (authority.workMode !== "standard")
      throw forbidden("Slack writes require standard work mode");
    if (authority.revision !== action.payload.revision)
      throw forbidden(
        "Slack authorization changed after this operation was queued",
      );
    if (name !== "slack_create_channel" && name !== "slack_open_dm")
      await authorizeSlackWrite(db, authority, api, String(args.channel));
    if (name === "slack_update_message" || name === "slack_delete_message") {
      const message = await slackMessage(api, args);
      if (!message || message.user !== authority.endpoint.botExternalId)
        throw forbidden("Only this bot's own messages can be changed");
    }
    if (args.file) await authorizeSlackDocument(db, authority, api, args, true);
    let result: SlackObject;
    const { idempotencyKey: _key, thread_ts: _thread, ...parameters } = args;
    if (name === "slack_open_dm") {
      if (!authority.endpoint.allowDirectMessages)
        throw forbidden("Direct messages are disabled");
      const user = object(
        (await api("users.info", { user: authority.slackUserId })).user,
      );
      if (
        user.id !== authority.slackUserId ||
        user.deleted === true ||
        user.is_bot === true ||
        user.team_id !== authority.endpoint.providerAccountId
      )
        throw forbidden(
          "The linked Slack user is no longer an active workspace member",
        );
      result = await api(tool.method, { users: authority.slackUserId });
    } else if (name === "slack_upload_file") {
      const [attachment] = await db
        .select({ asset: assets })
        .from(issueAttachments)
        .innerJoin(
          assets,
          and(
            eq(assets.id, issueAttachments.assetId),
            eq(assets.companyId, binding.companyId),
          ),
        )
        .where(
          and(
            eq(issueAttachments.id, String(args.attachmentId)),
            eq(issueAttachments.companyId, binding.companyId),
            eq(issueAttachments.issueId, binding.issueId),
          ),
        );
      if (!attachment || attachment.asset.byteSize > 20 * 1024 * 1024)
        throw forbidden(
          "Upload requires an attachment on this task, at most 20 MB",
        );
      const stored = await getStorageService().getObject(
        binding.companyId,
        attachment.asset.objectKey,
      );
      const chunks: Buffer[] = [];
      let count = 0;
      try {
        for await (const chunk of stored.stream) {
          const bytes = Buffer.from(chunk);
          count += bytes.length;
          if (count > 20 * 1024 * 1024)
            throw forbidden("Attachment exceeds upload limit");
          chunks.push(bytes);
        }
      } finally {
        stored.stream.destroy();
      }
      const bytes = Buffer.concat(chunks);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        attachment.asset.sha256
      )
        throw forbidden("Attachment changed before upload");
      const upload = await api("files.getUploadURLExternal", {
        filename: attachment.asset.originalFilename ?? "attachment",
        length: bytes.length,
      });
      const url = new URL(String(upload.upload_url));
      if (
        url.protocol !== "https:" ||
        url.hostname !== "files.slack.com" ||
        url.username ||
        url.password ||
        url.port
      )
        throw forbidden("Slack returned an unsupported upload destination");
      // Store the provider receipt before transport. An uncertain finish is never blindly retried.
      await db.transaction(async (tx) => {
        await notifyChatPublicationWork(tx);
        return tx
          .update(chatActions)
          .set({
            result: { fileId: upload.file_id, phase: "upload_allocated" },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, action.id));
      });
      const uploaded = await fetchImpl(url, {
        method: "POST",
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/octet-stream" },
      });
      await uploaded.body?.cancel();
      if (!uploaded.ok) throw unprocessable("Slack upload did not complete");
      authority = await resolveSlackTaskAuthority(db, binding);
      if (
        authority.workMode !== "standard" ||
        authority.revision !== action.payload.revision
      )
        throw forbidden("Slack authorization changed during upload");
      await authorizeSlackWrite(db, authority, api, String(args.channel));
      result = await api("files.completeUploadExternal", {
        files: [
          {
            id: upload.file_id,
            title: args.title ?? attachment.asset.originalFilename,
          },
        ],
        channel_id: args.channel,
        thread_ts: args.thread_ts,
      });
    } else if (name === "slack_start_task") {
      // The chosen bot posts the starter and admits the task through the same
      // durable path as its own Slack command; this run's requester stays the actor.
      const [agent] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, binding.agentId));
      const [user] = await db
        .select({ name: authUsers.name })
        .from(authUsers)
        .where(eq(authUsers.id, authority.userId));
      const [source] = await db
        .select({ identifier: issues.identifier })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, binding.companyId),
            eq(issues.id, binding.issueId),
          ),
        );
      const label = (value: string) =>
        value.replace(/[\r\n[\]]/g, " ").trim().slice(0, 160);
      const taskText = `[Started by ${label(agent?.name ?? "an agent")} from ${source?.identifier ?? binding.issueId} on behalf of ${label(user?.name ?? authority.userId)}]\n\n${String(args.task)}`;
      const [queued] = await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "slash_task_start");
        return tx
          .insert(chatActions)
          .values({
            companyId: binding.companyId,
            endpointId: taskStart!.id,
            principalId: authority.principalId,
            kind: "slash_task_start",
            providerActionId: `slack_start_task:${action.id}`,
            payload: {
              version: 1,
              channelId: String(args.channel),
              command: "slack_start_task",
              syntheticMessageId: createHash("sha256")
                .update(`slack_start_task:${action.id}`)
                .digest("hex"),
              taskText,
              ...(args.starter ? { starterText: String(args.starter) } : {}),
              sourceIssueId: binding.issueId,
              sourceAgentId: binding.agentId,
            },
            status: "queued",
          })
          .onConflictDoNothing()
          .returning({ id: chatActions.id });
      });
      result = { channel: String(args.channel), task_start_id: queued?.id };
    } else if (name === "slack_post_message")
      result = await api(tool.method, {
        ...parameters,
        client_msg_id: args.idempotencyKey,
        ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
    else if (
      [
        "slack_add_reaction",
        "slack_remove_reaction",
        "slack_add_pin",
        "slack_remove_pin",
      ].includes(name)
    ) {
      const { ts, ...rest } = parameters;
      result = await api(tool.method, { ...rest, timestamp: ts });
    } else if (
      name === "slack_add_bookmark" ||
      name === "slack_remove_bookmark"
    ) {
      const { channel, ...rest } = parameters;
      result = await api(tool.method, {
        ...rest,
        channel_id: channel,
        ...(name === "slack_add_bookmark" ? { type: "link" } : {}),
      });
    } else if (name === "slack_create_canvas")
      result = await api(tool.method, {
        channel_id: args.channel,
        title: args.title,
        document_content: { type: "markdown", markdown: args.markdown },
      });
    else if (name === "slack_edit_canvas")
      result = await api(tool.method, {
        canvas_id: args.file,
        changes: [
          {
            operation: "insert_at_end",
            document_content: { type: "markdown", markdown: args.markdown },
          },
        ],
      });
    else if (name === "slack_replace_canvas_section")
      result = await api(tool.method, {
        canvas_id: args.file,
        changes: [
          {
            operation: "replace",
            section_id: args.section_id,
            document_content: { type: "markdown", markdown: args.markdown },
          },
        ],
      });
    else if (name === "slack_share_list")
      result = await api(tool.method, {
        list_id: args.file,
        channel_ids: [args.channel],
        access_level: args.access_level,
      });
    else if (name === "slack_edit_list")
      result = await api(tool.method, { list_id: args.file, name: args.name });
    else if (name === "slack_create_list")
      result = await api(tool.method, { name: args.name });
    else if (name === "slack_create_list_item")
      result = await api(tool.method, {
        list_id: args.file,
        initial_fields: [
          { column_id: args.column_id, rich_text: richText(args.text) },
        ],
      });
    else if (name === "slack_update_list_item")
      result = await api(tool.method, {
        list_id: args.file,
        cells: [
          {
            row_id: args.row_id,
            column_id: args.column_id,
            rich_text: richText(args.text),
          },
        ],
      });
    else if (name === "slack_invite")
      result = await api(tool.method, {
        channel: args.channel,
        users: (args.users as string[]).join(","),
      });
    else if (name === "slack_create_channel") {
      result = await db.transaction(async (tx) => {
        // Membership callbacks and inbound admission use this same endpoint
        // lock. Persist the bot's own channel as enabled before either can
        // discover it: the bot that created it responds there at once.
        await tx
          .select({ id: chatEndpoints.id })
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.id, authority.endpoint.id),
              eq(chatEndpoints.companyId, binding.companyId),
            ),
          )
          .for("update");
        const created = await api(tool.method, parameters);
        const channel = object(created.channel);
        if (typeof channel.id !== "string")
          throw conflict("Slack did not return the created channel ID");
        await tx
          .insert(chatEndpointResources)
          .values({
            companyId: binding.companyId,
            endpointId: authority.endpoint.id,
            type: "channel",
            providerResourceId: channel.id,
            label: `#${String(channel.name ?? args.name)}`,
            availability: "available",
            enabled: true,
            metadata: {
              source: "slack_tool_create_channel",
              private: args.is_private === true,
            },
          })
          .onConflictDoUpdate({
            target: [
              chatEndpointResources.endpointId,
              chatEndpointResources.type,
              chatEndpointResources.providerResourceId,
            ],
            set: { enabled: true, updatedAt: new Date() },
          });
        return created;
      });
    } else result = await api(tool.method, parameters);
    const receipt = {
      channel:
        typeof result.channel === "string"
          ? result.channel
          : object(result.channel).id,
      ts: result.ts,
      canvasId: result.canvas_id,
      listId: object(result.list).id ?? result.list_id,
      bookmarkId: object(result.bookmark).id,
      item: result.item,
      listSchema: object(result.list_metadata).schema,
      fileIds: objects(result.files).map((f) => f.id),
      taskStartId: result.task_start_id,
      ...(name === "slack_create_list"
        ? {
            note: "List created for the bot; sharing access requires a separate approved action.",
          }
        : {}),
    };
    await db.transaction(async (tx) => {
      await notifyChatPublicationWork(tx);
      return tx
        .update(chatActions)
        .set({ status: "processed", result: receipt, updatedAt: new Date() })
        .where(eq(chatActions.id, action.id));
    });
    await logActivity(db, {
      companyId: binding.companyId,
      actorType: "agent",
      actorId: binding.agentId,
      agentId: binding.agentId,
      runId: binding.runId,
      action: "chat.slack_tool.executed",
      entityType: "chat_endpoint",
      entityId: authority.endpoint.id,
      details: { actionId: action.id, tool: name },
    });
    return { actionId: action.id, state: "delivered", ...receipt };
  } catch (error) {
    const details = error instanceof HttpError ? object(error.details) : {};
    const definite =
      error instanceof HttpError &&
      (error.status === 403 ||
        error.status === 429 ||
        (typeof details.code === "string" &&
          ![
            "slack_transport_uncertain",
            "slack_http_error",
            "slack_internal_error",
            "slack_fatal_error",
            "slack_unknown_error",
            "slack_request_timeout",
            "slack_service_unavailable",
          ].includes(details.code)));
    await db.transaction(async (tx) => {
      await notifyChatPublicationWork(tx);
      return tx
        .update(chatActions)
        .set({
          status: definite ? "failed" : "uncertain",
          result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || ${JSON.stringify({ code: details.code ?? "slack_delivery_uncertain", ...(error instanceof HttpError && error.status === 429 ? { retryAt: new Date(Date.now() + Number(details.retryAfterSeconds ?? 60) * 1000).toISOString() } : {}) })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
    });
    if (error instanceof HttpError)
      error.details = {
        ...details,
        actionId: action.id,
        state: definite ? "failed" : "uncertain",
      };
    throw error;
  }
}

/** The bot that opens a started task: this one or a sibling in the same company and workspace,
 * where the requester linked Slack and the bot can respond in the channel. */
async function slackTaskStartTarget(
  db: Db,
  authority: Awaited<ReturnType<typeof resolveSlackTaskAuthority>>,
  args: SlackObject,
) {
  const targetId =
    typeof args.targetEndpointId === "string"
      ? args.targetEndpointId
      : authority.endpoint.id;
  const [target] = await db
    .select()
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.id, targetId),
        eq(chatEndpoints.companyId, authority.endpoint.companyId),
        eq(chatEndpoints.provider, "slack"),
        eq(chatEndpoints.providerAccountId, authority.endpoint.providerAccountId!),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ),
    );
  if (!target)
    throw forbidden(
      "The target Slack bot is not a bot of this company in this workspace",
    );
  const [resource] = await db
    .select({ id: chatEndpointResources.id })
    .from(chatEndpointResources)
    .where(
      and(
        eq(chatEndpointResources.companyId, target.companyId),
        eq(chatEndpointResources.endpointId, target.id),
        eq(chatEndpointResources.providerResourceId, String(args.channel)),
        eq(chatEndpointResources.availability, "available"),
        eq(chatEndpointResources.enabled, true),
      ),
    );
  if (!resource)
    throw forbidden(
      "The target bot cannot respond in this channel. Invite it, or enable the channel in its connection Settings.",
    );
  const [link] = await db
    .select({ id: chatIdentityLinks.id })
    .from(chatIdentityLinks)
    .where(
      and(
        eq(chatIdentityLinks.companyId, target.companyId),
        eq(chatIdentityLinks.endpointId, target.id),
        eq(chatIdentityLinks.principalId, authority.principalId),
        eq(chatIdentityLinks.paperclipUserId, authority.userId),
        eq(chatIdentityLinks.status, "linked"),
      ),
    );
  if (!link)
    throw forbidden(
      "The requester has not linked Slack on the target bot. They link once with that bot's connect command.",
    );
  return target;
}
