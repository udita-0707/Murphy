import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createProject, startTestEnv, type TestEnv, type TestProject } from "./helpers.js";

let env: TestEnv;
let hosted: Express;
let local: Express;

beforeAll(async () => {
  env = await startTestEnv();
  hosted = createApp({ repo: env.repo, encryptionKey: env.encryptionKey, mode: "hosted" });
  local = createApp({ repo: env.repo, encryptionKey: env.encryptionKey, mode: "local" });
});
afterAll(async () => {
  await env?.stop();
});

const create = (app: Express, p: TestProject, url: string) =>
  request(app).post("/v1/endpoints").set(p.auth).send({ url });
const patch = (app: Express, p: TestProject, id: string, body: object) =>
  request(app).patch(`/v1/endpoints/${id}`).set(p.auth).send(body);

describe("endpoint URL rules in hosted mode", () => {
  it.each([
    ["http://hooks.example.com/webhooks", "https in hosted mode"],
    ["https://user:secret@hooks.example.com/webhooks", "credentials"],
    ["https://good.com@127.0.0.1/", "credentials"],
    ["https://127.0.0.1/webhooks", "127.0.0.1"],
    ["https://10.0.0.5/webhooks", "10.0.0.5"],
    ["https://169.254.169.254/latest/meta-data/", "169.254.169.254"],
    ["https://0xa9fea9fe/", "169.254.169.254"],
    ["https://[::ffff:7f00:1]/", "::ffff:7f00:1"],
    ["https://[fd00:ec2::254]/", "fd00:ec2::254"],
    ["https://localhost/webhooks", "localhost"],
  ])("rejects %s on create with a clear error", async (url, mentions) => {
    const p = await createProject(env.repo);
    const res = await create(hosted, p, url);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("endpoint_url_not_allowed");
    expect(res.body.error.message).toContain(mentions);
    expect(res.body.error.request_id).toEqual(expect.any(String));
    expect(await env.prisma.endpoint.count({ where: { projectId: p.id } })).toBe(0);
  });

  it("accepts public https URLs, including hostnames whose DNS is not live yet", async () => {
    const p = await createProject(env.repo);
    for (const url of [
      "https://hooks.example.com/webhooks",
      "https://not-live-yet.invalid/webhooks",
    ]) {
      const res = await create(hosted, p, url);
      expect(res.status).toBe(201);
      expect(res.body.url).toBe(url);
    }
  });

  it("applies the same rules when the URL is patched, and leaves other patches alone", async () => {
    const p = await createProject(env.repo);
    const { body: endpoint } = await create(hosted, p, "https://hooks.example.com/webhooks");

    const bad = await patch(hosted, p, endpoint.id, { url: "https://192.168.0.10/hook" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("endpoint_url_not_allowed");
    const insecure = await patch(hosted, p, endpoint.id, {
      url: "http://hooks.example.com/webhooks",
    });
    expect(insecure.status).toBe(400);
    const unchanged = await request(hosted).get(`/v1/endpoints/${endpoint.id}`).set(p.auth);
    expect(unchanged.body.url).toBe("https://hooks.example.com/webhooks");

    expect(
      (await patch(hosted, p, endpoint.id, { url: "https://hooks2.example.com/w" })).status,
    ).toBe(200);
    expect((await patch(hosted, p, endpoint.id, { status: "paused" })).status).toBe(200);
  });
});

describe("endpoint URL rules in local mode (unchanged)", () => {
  it("accepts http, localhost and private addresses", async () => {
    const p = await createProject(env.repo);
    for (const url of [
      "http://127.0.0.1:4242/webhooks",
      "http://localhost:3000/hooks",
      "http://192.168.1.20:8080/x",
      "https://hooks.example.com/webhooks",
    ]) {
      expect((await create(local, p, url)).status).toBe(201);
    }
    const { body: endpoint } = await create(local, p, "http://127.0.0.1:4242/webhooks");
    expect((await patch(local, p, endpoint.id, { url: "http://10.0.0.7/hook" })).status).toBe(200);
  });

  it("still rejects non-http(s) schemes", async () => {
    const p = await createProject(env.repo);
    const res = await create(local, p, "ftp://example.com/x");
    expect(res.status).toBe(400);
  });
});

describe("API config", () => {
  it("defaults to hosted mode", async () => {
    const { loadConfig } = await import("../src/config.js");
    const base = {
      DATABASE_URL: "postgresql://x@localhost/db",
      MURPHY_ENCRYPTION_KEY: env.encryptionKey.toString("base64"),
    };
    expect(loadConfig(base).mode).toBe("hosted");
    expect(loadConfig({ ...base, MURPHY_MODE: "local" }).mode).toBe("local");
    expect(() => loadConfig({ ...base, MURPHY_MODE: "prod" })).toThrow(/MURPHY_MODE/);
  });
});
