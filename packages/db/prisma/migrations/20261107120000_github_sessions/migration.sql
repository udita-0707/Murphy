-- GitHub login (ADR 014). Additive: a new table, and an index that existing rows already satisfy.

CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_project_id_idx" ON "sessions"("project_id");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One project per GitHub user, even if a first login races itself. Exists only here: delete any
-- DROP INDEX for it that `prisma migrate dev` generates.
CREATE UNIQUE INDEX "projects_owner_user_id_key" ON "projects"("owner_user_id") WHERE "owner_user_id" IS NOT NULL;
