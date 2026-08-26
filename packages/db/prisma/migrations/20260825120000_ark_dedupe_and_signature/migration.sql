-- Two ARK hardening changes. Neither creates a table, so the blanket RLS
-- enable does not need extending.

-- ── 1. Deposit idempotency that survives an ARK REDELIVERY ──────────────
-- `webhookEventId` is our own id, minted fresh on every POST, so it makes a
-- replay of a STORED event safe but not a redelivery from ARK: that arrives
-- as a second WebhookEvent with a new id and posts the same money twice.
-- `dedupeKey` is derived from the event's own facts instead, so both copies
-- compute the same value.
ALTER TABLE "Deposit" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;

-- The guarantee lives in the DATABASE, not in a read-then-insert two workers
-- can both pass. Existing rows carry NULL, and Postgres treats NULLs as
-- distinct in a unique index, so nothing already banked is affected and no
-- backfill is required. Scoped to the deal so two customers' identical
-- deposits can never collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS "Deposit_dealId_dedupeKey_key"
  ON "Deposit" ("dealId", "dedupeKey");

-- ── 2. Per-source webhook signature configuration ───────────────────────
-- Held as data so switching verification on is a form an Admin fills in
-- rather than a deploy, and so one partner that signs cannot force every
-- other source to start signing too. All four stay NULL here: no existing
-- source changes behaviour until someone configures it.
ALTER TABLE "WebhookSource" ADD COLUMN IF NOT EXISTS "signatureHeader" TEXT;
ALTER TABLE "WebhookSource" ADD COLUMN IF NOT EXISTS "signatureAlgorithm" TEXT;
ALTER TABLE "WebhookSource" ADD COLUMN IF NOT EXISTS "signatureFormat" TEXT;
ALTER TABLE "WebhookSource" ADD COLUMN IF NOT EXISTS "signaturePrefix" TEXT;
