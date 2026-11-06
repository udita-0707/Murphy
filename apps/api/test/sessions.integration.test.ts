import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashSessionToken } from "../src/sessions.js";
import { createProject, startTestEnv, type TestEnv } from "./helpers.js";

const SECRET = "test-internal-secret-long-enough-for-this";

let env: TestEnv;
let app: Express;

beforeAll(async () => {
  env = await startTestEnv();
  app = createApp({
    repo: env.repo,
    encryptionKey: env.encryptionKey,
    internalSecret: SECRET,
    logError: (err) => console.error(err),
  });
});
afterAll(async () => {
  await env?.stop();
});

const login = (github_id: number, name = "octo", secret = SECRET) =>
  request(app)
    .post("/internal/github-login")
    .set("x-murphy-internal", secret)
    .send({ github_id, login: name });

const tokenFor = async (github_id: number) => {
  const res = await login(github_id);
  expect(res.status).toBe(201);
  return (res.body as { token: string }).token;
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("the internal login route", () => {
  it("does not exist without the secret, or when no secret is configured", async () => {
    expect((await login(1, "x", "wrong")).status).toBe(404);
    const res = await request(app)
      .post("/internal/github-login")
      .send({ github_id: 1, login: "x" });
    expect(res.status).toBe(404);
    const off = createApp({ repo: env.repo, encryptionKey: env.encryptionKey });
    const none = await request(off)
      .post("/internal/github-login")
      .set("x-murphy-internal", "")
      .send({ github_id: 1, login: "x" });
    expect(none.status).toBe(404);
  });

  it("is not reachable with an API key", async () => {
    const project = await createProject(env.repo, "keyed");
    const res = await request(app)
      .post("/internal/github-login")
      .set(project.auth)
      .send({ github_id: 2, login: "x" });
    expect(res.status).toBe(404);
  });

  it("refuses a bad body", async () => {
    const res = await request(app)
      .post("/internal/github-login")
      .set("x-murphy-internal", SECRET)
      .send({ github_id: "1; drop table", login: "x" });
    expect(res.status).toBe(400);
  });
});

describe("mapping a GitHub user to a project", () => {
  it("creates a project on first login, and reuses it after", async () => {
    await tokenFor(100);
    const before = await env.prisma.project.count({ where: { ownerUserId: "github:100" } });
    await tokenFor(100);
    const after = await env.prisma.project.count({ where: { ownerUserId: "github:100" } });
    expect([before, after]).toEqual([1, 1]);
  });

  it("keeps the one project when a first login races itself", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => login(200)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await env.prisma.project.count({ where: { ownerUserId: "github:200" } })).toBe(1);
  });
});

describe("a session", () => {
  it("works as a credential on the API", async () => {
    const res = await request(app)
      .get("/v1/scenarios")
      .set(bearer(await tokenFor(300)));
    expect(res.status).toBe(200);
  });

  it("is stored only as a hash", async () => {
    const token = await tokenFor(301);
    const rows = await env.prisma.session.findMany();
    expect(JSON.stringify(rows)).not.toContain(token);
    const tokenHash = new Uint8Array(hashSessionToken(token));
    expect(await env.prisma.session.count({ where: { tokenHash } })).toBe(1);
  });

  it("sees only its own project", async () => {
    const mine = await tokenFor(400);
    const theirs = await tokenFor(401);
    const created = await request(app)
      .post("/v1/endpoints")
      .set(bearer(mine))
      .send({ url: "https://example.com/hook" });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    expect((await request(app).get(`/v1/endpoints/${id}`).set(bearer(mine))).status).toBe(200);
    expect((await request(app).get(`/v1/endpoints/${id}`).set(bearer(theirs))).status).toBe(404);
    const list = await request(app).get("/v1/endpoints").set(bearer(theirs));
    expect((list.body as { data: unknown[] }).data).toEqual([]);
  });

  it("stops working when revoked, and revoking is safe to repeat", async () => {
    const token = await tokenFor(500);
    const revoke = () =>
      request(app)
        .post("/internal/session-revoke")
        .set("x-murphy-internal", SECRET)
        .send({ token });
    expect((await revoke()).status).toBe(204);
    expect((await revoke()).status).toBe(204);
    expect((await request(app).get("/v1/scenarios").set(bearer(token))).status).toBe(401);
  });

  it("stops working when expired", async () => {
    const token = await tokenFor(600);
    await env.prisma.session.update({
      where: { tokenHash: new Uint8Array(hashSessionToken(token)) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await request(app).get("/v1/scenarios").set(bearer(token))).status).toBe(401);
  });

  it("refuses a token that is well shaped but unknown", async () => {
    const res = await request(app)
      .get("/v1/scenarios")
      .set(bearer(`ms_${"a".repeat(43)}`));
    expect(res.status).toBe(401);
  });
});

describe("API keys", () => {
  it("keep working next to sessions", async () => {
    const project = await createProject(env.repo, "still-keyed");
    expect((await request(app).get("/v1/scenarios").set(project.auth)).status).toBe(200);
  });
});
