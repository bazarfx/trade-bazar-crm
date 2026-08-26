-- The measured grid. `CRM _ Leads_Create Leads` draws four 273-wide columns
-- at a 12px gap across the 1128 content width; the column cap was 3, which
-- made the designed layout unreachable. Only the DEFAULT for new sections
-- changes here — existing sections keep whatever the Admin arranged.
ALTER TABLE "FormSection" ALTER COLUMN "columns" SET DEFAULT 4;
