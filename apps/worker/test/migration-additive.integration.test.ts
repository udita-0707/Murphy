import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/prisma/migrations",
);
const SIMULATOR_MIGRATION = "20261106120000_simulator_runs";

let container: StartedPostgreSqlContainer;

async function psql(sql: string): Promise<string> {
  const result = await container.exec([
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-U",
    container.getUsername(),
    "-d",
    container.getDatabase(),
    "-c",
    sql,
  ]);
  if (result.exitCode !== 0) throw new Error(result.output);
  return result.output.trim();
}

const apply = (name: string) =>
  psql(readFileSync(path.join(MIGRATIONS, name, "migration.sql"), "utf8"));

/** Applies the real migration on top of rows written under the schema before it. */
describe("the simulator migration keeps existing data valid", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    const earlier = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name < SIMULATOR_MIGRATION)
      .map((e) => e.name)
      .sort();
    expect(earlier.length).toBeGreaterThan(0);
    for (const name of earlier) await apply(name);

    await psql(`
      WITH p AS (INSERT INTO projects (name) VALUES ('before') RETURNING id),
      en AS (
        INSERT INTO endpoints (project_id, url, secret_enc)
        SELECT id, 'https://example.com/hook', '\\x00'::bytea FROM p RETURNING id, project_id
      ),
      ev AS (
        INSERT INTO events (project_id, type, payload, idempotency_key, request_hash)
        SELECT id, 'payment.captured', '{"id":"pay_1"}', 'key-1', 'h' FROM p RETURNING id, project_id
      ),
      d AS (
        INSERT INTO deliveries (project_id, event_id, endpoint_id, status)
        SELECT ev.project_id, ev.id, en.id, 'succeeded' FROM ev, en RETURNING id
      ),
      s AS (
        INSERT INTO scenarios (project_id, slug, name, difficulty, definition_yaml)
        SELECT id, 'old', 'Old', 'beginner', 'x' FROM p RETURNING id, project_id
      )
      INSERT INTO scenario_runs (project_id, scenario_id, endpoint_id, status, report)
      SELECT s.project_id, s.id, en.id, 'passed', '{"old":true}' FROM s, en`);
    await apply(SIMULATOR_MIGRATION);
  });
  afterAll(async () => {
    await container?.stop();
  });

  it("is the newest migration, so this test covers what ships", () => {
    const all = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(all.at(-1)).toBe(SIMULATOR_MIGRATION);
  });

  it("leaves old rows unchanged, with the new columns empty", async () => {
    expect(await psql(`SELECT type, idempotency_key, scenario_run_id FROM events`)).toBe(
      "payment.captured|key-1|",
    );
    expect(await psql(`SELECT status FROM deliveries`)).toBe("succeeded");
    expect(
      await psql(`SELECT status, report::text, seed, target_label, state_url, deadline_at, plan
                  FROM scenario_runs`),
    ).toBe('passed|{"old": true}|||||');
  });

  it("only adds: every new column is nullable", async () => {
    const notNull = await psql(`
      SELECT count(*) FROM information_schema.columns
      WHERE is_nullable = 'NO' AND (
        (table_name = 'events' AND column_name = 'scenario_run_id') OR
        (table_name = 'scenario_runs'
          AND column_name IN ('seed', 'target_label', 'state_url', 'deadline_at', 'plan')))`);
    expect(notNull).toBe("0");
  });

  it("old-style writes still work after it", async () => {
    await psql(`
      INSERT INTO events (project_id, type, payload, idempotency_key, request_hash)
      SELECT id, 'x', '{}', 'key-2', 'h' FROM projects`);
    expect(await psql(`SELECT count(*) FROM events`)).toBe("2");
  });

  it("allows one built-in per slug, without limiting projects", async () => {
    const insert = `
      INSERT INTO scenarios (slug, name, difficulty, definition_yaml, is_public)
      VALUES ('builtin', 'B', 'beginner', 'x', true)`;
    await psql(insert);
    await expect(psql(insert)).rejects.toThrow(/scenarios_builtin_slug_key/);
    await psql(`
      INSERT INTO scenarios (project_id, slug, name, difficulty, definition_yaml)
      SELECT id, 'builtin', 'P', 'beginner', 'x' FROM projects`);
  });
});
