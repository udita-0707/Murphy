import { describe, expect, it } from "vitest";
import { checkLocalOnly } from "./local-only.js";

const LOCAL = "postgresql://u:p@localhost:5432/d";

describe("checkLocalOnly", () => {
  it.each([
    ["local mode on localhost", { MURPHY_MODE: "local", DATABASE_URL: LOCAL }],
    ["127.0.0.1", { MURPHY_MODE: "local", DATABASE_URL: "postgresql://u:p@127.0.0.1/d" }],
    ["IPv6 loopback", { MURPHY_MODE: "local", DATABASE_URL: "postgresql://u:p@[::1]/d" }],
  ])("allows %s", (_name, env) => {
    expect(checkLocalOnly(env, "x")).toEqual({ ok: true });
  });

  it.each([
    ["an unset mode, which means hosted", { DATABASE_URL: LOCAL }, "x only runs with"],
    ["hosted mode", { MURPHY_MODE: "hosted", DATABASE_URL: LOCAL }, "x only runs with"],
    ["an unknown mode", { MURPHY_MODE: "prod", DATABASE_URL: LOCAL }, "MURPHY_MODE must be"],
    ["no database", { MURPHY_MODE: "local" }, "DATABASE_URL is not set"],
    ["a bad URL", { MURPHY_MODE: "local", DATABASE_URL: "nope" }, "not a valid URL"],
    [
      "a remote database in local mode",
      { MURPHY_MODE: "local", DATABASE_URL: "postgresql://u:p@db.example.com/d" },
      "x only runs against localhost",
    ],
    [
      "a host that only starts with localhost",
      { MURPHY_MODE: "local", DATABASE_URL: "postgresql://u:p@localhost.evil.com/d" },
      "x only runs against localhost",
    ],
  ])("refuses %s", (_name, env, reason) => {
    const result = checkLocalOnly(env, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});
