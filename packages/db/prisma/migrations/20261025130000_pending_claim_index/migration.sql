-- Partial index for the per-project fair claim (ADR 004). Prisma's schema language cannot
-- express partial indexes, so this index lives only in migrations; remove any
-- "DROP INDEX deliveries_pending_project_due_idx" that `prisma migrate dev` generates later.
CREATE INDEX "deliveries_pending_project_due_idx"
  ON "deliveries" ("project_id", "next_attempt_at")
  WHERE "status" = 'pending';
