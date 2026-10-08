import { createHash, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, invites } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const PASSWORD = "correct-horse-battery-staple";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(authDisableSignUp = true): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

describeEmbeddedPostgres("invite-only sign-up", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    inviteOnly: process.env.PAPERCLIP_AUTH_INVITE_ONLY_SIGN_UP,
  };

  async function invite(values: Partial<typeof invites.$inferInsert> = {}) {
    const token = `pcp_invite_${randomBytes(32).toString("base64url")}`;
    await db.insert(invites).values({
      inviteType: "company_join",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      allowedJoinTypes: "both",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...values,
    });
    return token;
  }

  function signUp(email: string, referer?: string) {
    const req = request(app).post("/api/auth/sign-up/email").set("origin", ORIGIN);
    if (referer) req.set("referer", referer);
    return req.send({ email, password: PASSWORD, name: email.split("@")[0] });
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-invite-only-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    process.env.PAPERCLIP_AUTH_INVITE_ONLY_SIGN_UP = "true";
    database = await startEmbeddedPostgresTestDatabase("paperclip-invite-only-signup-");
    db = createDb(database.connectionString);
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(createBetterAuthInstance(db, testConfig(), [ORIGIN])));
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    for (const [key, value] of [
      ["BETTER_AUTH_SECRET", originalEnv.secret],
      ["PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", originalEnv.rateLimit],
      ["PAPERCLIP_AUTH_INVITE_ONLY_SIGN_UP", originalEnv.inviteOnly],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("refuses a sign-up that does not come from an invite page", async () => {
    expect((await signUp("stranger@example.com")).status).toBe(403);
    expect((await signUp("stranger2@example.com", `${ORIGIN}/auth`)).status).toBe(403);
  });

  it("refuses a sign-up from an unknown, expired, revoked, accepted or agent-only invite", async () => {
    const unknown = `pcp_invite_${randomBytes(32).toString("base64url")}`;
    const expired = await invite({ expiresAt: new Date(Date.now() - 1000) });
    const revoked = await invite({ revokedAt: new Date() });
    const accepted = await invite({ acceptedAt: new Date() });
    const agentOnly = await invite({ allowedJoinTypes: "agent" });
    for (const [i, token] of [unknown, expired, revoked, accepted, agentOnly].entries()) {
      expect((await signUp(`bad${i}@example.com`, `${ORIGIN}/invite/${token}`)).status).toBe(403);
    }
  });

  it("allows a sign-up from an open invite page", async () => {
    const token = await invite();
    const res = await signUp("employee@example.com", `${ORIGIN}/invite/${token}`);
    expect(res.status).toBe(200);
    expect(res.body?.user?.email).toBe("employee@example.com");
  });

  it("allows a sign-up from the auth page that returns to an open invite", async () => {
    const token = await invite();
    const res = await signUp("employee2@example.com", `${ORIGIN}/auth?next=${encodeURIComponent(`/invite/${token}`)}`);
    expect(res.status).toBe(200);
  });

  it("keeps sign-up closed when invite-only mode is off and sign-up is disabled", async () => {
    process.env.PAPERCLIP_AUTH_INVITE_ONLY_SIGN_UP = "false";
    try {
      const closed = express();
      closed.all("/api/auth/{*authPath}", createBetterAuthHandler(createBetterAuthInstance(db, testConfig(true), [ORIGIN])));
      const token = await invite();
      const res = await request(closed).post("/api/auth/sign-up/email").set("origin", ORIGIN)
        .set("referer", `${ORIGIN}/invite/${token}`)
        .send({ email: "closed@example.com", password: PASSWORD, name: "closed" });
      expect(res.status).not.toBe(200);
    } finally {
      process.env.PAPERCLIP_AUTH_INVITE_ONLY_SIGN_UP = "true";
    }
  });

  it("leaves sign-up untouched when invite-only mode is off", async () => {
    process.env.PAPERCLIP_AUTH_INVITE_ONLY_SIGN_UP = "false";
    try {
      const open = express();
      open.all("/api/auth/{*authPath}", createBetterAuthHandler(createBetterAuthInstance(db, testConfig(false), [ORIGIN])));
      const res = await request(open).post("/api/auth/sign-up/email").set("origin", ORIGIN)
        .send({ email: "open@example.com", password: PASSWORD, name: "open" });
      expect(res.status).toBe(200);
    } finally {
      process.env.PAPERCLIP_AUTH_INVITE_ONLY_SIGN_UP = "true";
    }
  });
});
