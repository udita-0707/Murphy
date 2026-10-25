import { describe, expect, it } from "vitest";
import { checkResetAllowed, RESET_STEPS, resetDemo, type Step } from "../src/reset.js";

const LOCAL_DB = "postgresql://murphy:pw@localhost:54320/murphy?schema=public";

describe("checkResetAllowed", () => {
  it("allows local mode against a localhost database", () => {
    for (const url of [
      LOCAL_DB,
      "postgresql://m:p@127.0.0.1:54320/murphy",
      "postgresql://m:p@[::1]:54320/murphy",
    ]) {
      expect(checkResetAllowed({ MURPHY_MODE: "local", DATABASE_URL: url })).toEqual({ ok: true });
    }
  });

  it("refuses hosted mode, including when MURPHY_MODE is unset", () => {
    for (const mode of ["hosted", "", undefined]) {
      const result = checkResetAllowed({ MURPHY_MODE: mode, DATABASE_URL: LOCAL_DB });
      expect(result).toMatchObject({ ok: false });
      expect(result.ok || result.reason).toMatch(/MURPHY_MODE=local/);
    }
    expect(checkResetAllowed({ MURPHY_MODE: "staging", DATABASE_URL: LOCAL_DB })).toMatchObject({
      ok: false,
    });
  });

  it("refuses a database that is not on localhost", () => {
    for (const url of [
      "postgresql://u:p@db.example.com:5432/murphy",
      "postgresql://u:p@10.0.0.5:5432/murphy",
      "postgresql://u:p@localhost.evil.com:5432/murphy",
      "not a url",
    ]) {
      expect(checkResetAllowed({ MURPHY_MODE: "local", DATABASE_URL: url })).toMatchObject({
        ok: false,
      });
    }
    expect(checkResetAllowed({ MURPHY_MODE: "local" })).toMatchObject({
      ok: false,
      reason: "DATABASE_URL is not set",
    });
  });
});

describe("resetDemo", () => {
  it("runs nothing when the guard refuses", () => {
    const ran: Step[] = [];
    const log: string[] = [];
    const status = resetDemo(
      { MURPHY_MODE: "hosted", DATABASE_URL: LOCAL_DB },
      (s) => (ran.push(s), 0),
      (l) => log.push(l),
    );
    expect(status).toBe(1);
    expect(ran).toEqual([]);
    expect(log[0]).toMatch(/refused.*Nothing was changed/);
  });

  it("wipes volumes, starts infra, migrates and seeds, in that order", () => {
    const ran: string[] = [];
    const status = resetDemo(
      { MURPHY_MODE: "local", DATABASE_URL: LOCAL_DB },
      (s) => (ran.push(`${s.command} ${s.args.join(" ")}`), 0),
      () => {},
    );
    expect(status).toBe(0);
    expect(ran).toEqual([
      "docker compose --env-file .env -f infra/docker-compose.yml down -v",
      "docker compose --env-file .env -f infra/docker-compose.yml up -d --wait",
      "pnpm db:migrate",
      "pnpm db:seed",
    ]);
    expect(RESET_STEPS).toHaveLength(4);
  });

  it("stops at the first failing step", () => {
    const ran: string[] = [];
    const status = resetDemo(
      { MURPHY_MODE: "local", DATABASE_URL: LOCAL_DB },
      (s) => (ran.push(s.label), s.args.includes("up") ? 3 : 0),
      () => {},
    );
    expect(status).toBe(3);
    expect(ran).toEqual(["Stop infra and delete its volumes", "Start Postgres and Redis"]);
  });
});
