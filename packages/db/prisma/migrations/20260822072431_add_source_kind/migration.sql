-- WebhookSource.kind: WHAT posts to a source — 'CAMPAIGN' or 'ARK'. A column
-- rather than a name prefix, because the name is Admin-editable and the two
-- kinds answer on different public endpoints, drain through different queues
-- and hold different mapping shapes. Existing rows are campaign sources.
--
-- WebhookSource.signingSecret: the per-source secret for the receivers'
-- signature-verification slot. Null until a platform's auth scheme is known.
--
-- WebhookEvent.outcome: which of the conversion pipeline's outcomes an ARK
-- event took (spec §7). Null for campaign intake and unsettled events.
--
-- No table is created here, so no RLS statement is needed: both tables were
-- enabled in 20260818160000_rls_enable.

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "outcome" TEXT;

-- AlterTable
ALTER TABLE "WebhookSource" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'CAMPAIGN',
ADD COLUMN     "signingSecret" TEXT;
