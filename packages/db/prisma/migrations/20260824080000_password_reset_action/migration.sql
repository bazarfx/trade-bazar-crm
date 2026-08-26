-- A password reset is its own auditable act (spec §5.5): it is not a field
-- edit — no diff is written, because a hash in the append-only log could never
-- be taken back out — so it needs its own action for the timeline to narrate.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET';
