import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";

const REDIRECT_URI = "https://paperclip.example/api/tools/oauth/callback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("personal identities of several members on one connection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof toolAccessService>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-member-personal-identities-");
    db = createDb(database.connectionString);
    service = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url, init) => fetch(url, init),
    });
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function personalConnection(memberPersonalIdentities?: boolean) {
    const [company] = await db
      .insert(companies)
      .values({ name: `Member identities ${randomUUID()}`, issuePrefix: `MI${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning();
    for (const userId of ["alice", "bob"]) {
      await db.insert(companyMemberships).values({
        companyId: company!.id,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "operator",
      });
    }
    const [application] = await db
      .insert(toolApplications)
      .values({ companyId: company!.id, name: `Google ${randomUUID()}`, type: "mcp_http", status: "active" })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId: company!.id,
        applicationId: application!.id,
        name: `Google ${randomUUID()}`,
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "active",
        enabled: true,
        createdByUserId: "alice",
        config: {
          url: "https://mcp.example/mcp",
          oauth: {
            authorizationUrl: "https://accounts.example/o/oauth2/v2/auth?access_type=offline&prompt=consent",
            tokenUrl: "https://oauth2.example/token",
            clientId: "shared-oauth-client",
            clientRegistrationSource: "manual",
            scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
          },
          ...(memberPersonalIdentities === undefined ? {} : { memberPersonalIdentities }),
        },
      })
      .returning();
    return { companyId: company!.id, connectionId: connection!.id };
  }

  function start(companyId: string, connectionId: string, actorId: string, subjectUserId?: string) {
    return service.startOAuth(companyId, connectionId, {
      redirectUri: REDIRECT_URI,
      actor: { actorType: "user", actorId },
      ...(subjectUserId ? { subjectUserId } : {}),
    });
  }

  async function stateSubject(authorizationUrl: string) {
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    return (await service.peekOAuthState(state))?.subjectUserId;
  }

  it("keeps a personal connection to the person who created it by default", async () => {
    const { companyId, connectionId } = await personalConnection();
    await expect(start(companyId, connectionId, "bob", "bob")).rejects.toThrow(
      "Only the existing personal identity can reconnect this connection",
    );
    expect(await stateSubject((await start(companyId, connectionId, "alice", "alice")).authorizationUrl)).toBe("alice");
  });

  it("lets every member add their own identity when the connection allows it", async () => {
    const { companyId, connectionId } = await personalConnection(true);
    const bob = await start(companyId, connectionId, "bob", "bob");
    expect(await stateSubject(bob.authorizationUrl)).toBe("bob");
    const url = new URL(bob.authorizationUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("client_id")).toBe("shared-oauth-client");
    expect(await stateSubject((await start(companyId, connectionId, "alice", "alice")).authorizationUrl)).toBe("alice");
  });

  it("never lets a member add someone else's identity", async () => {
    const { companyId, connectionId } = await personalConnection(true);
    await expect(start(companyId, connectionId, "bob", "alice")).rejects.toThrow(
      "Board users may only reconnect their own personal connection",
    );
  });

  it("ignores anything but an explicit true", async () => {
    const { companyId, connectionId } = await personalConnection(false);
    await expect(start(companyId, connectionId, "bob", "bob")).rejects.toThrow(
      "Only the existing personal identity can reconnect this connection",
    );
    await db
      .update(toolConnections)
      .set({ config: { url: "https://mcp.example/mcp", memberPersonalIdentities: "true" } })
      .where(eq(toolConnections.id, connectionId));
    await expect(start(companyId, connectionId, "bob", "bob")).rejects.toThrow();
  });
});
