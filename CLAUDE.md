# Trade Bazar CRM Platform — working rules

Read this before writing any code. It exists because this project has one
architectural property that is easy to destroy accidentally and expensive to
restore. Spec: `docs/CRM-MASTER-SPEC-v3.md`.

---

## The prime directive

> **There is no "Leads module."**
>
> There is a record engine. Leads is a row in `ModuleDefinition` that
> instantiates it. So is Deals. So is Campaigns. So is whatever the client
> invents in 2027 without calling anyone.

If you are about to create `LeadsController`, `LeadsList.tsx`, `DealForm.tsx`
or anything else named after one module — **stop**. Build the generic component
and configure it. One page component per *view type*, never per module.

**Why this is non-negotiable:** the client holds a signed contract stating they
will never require a developer. Module-specific code makes that clause
unsatisfiable. Every hardcoded label, column, status, stage, section, dropdown,
permission or nav item is a defect.

**The test:** if adding a customer-visible option would require a code change,
a migration or a deploy, the design is wrong.

---

## The five invariants

1. **Nothing is ever unassigned.** Every lead and deal has an owner from the
   second it enters the system. `AssignmentStrategy` always returns an owner —
   the final fallback is the Admin. Returning null is a bug.

2. **Everything is logged.** One append-only audit log. Never UPDATE it, never
   DELETE from it. That log *is* the timeline rendered on every record — the
   timeline is not a second store.

3. **The database stays firm.** `schema.prisma` holds system columns only.
   Admin-created fields live in `custom` (core tables) or `data` (generic
   records), governed by `FieldDefinition` at runtime. Adding a customer field
   must never touch the schema file.

4. **Soft delete, always.** Fields, options, statuses, records, modules. When an
   Admin deletes a field with data on 40,000 leads, that data survives and the
   timeline stays readable.

5. **Admin holds the keys first.** Account creation, password resets and
   destructive powers start with Admin, delegated via the permission matrix.

---

## Storage — the hybrid, and why

Core modules (`leads`, `deals`, `users`, `deposits`, `campaigns`) have real
tables with real indexes and foreign keys. That is where the volume lives.

Admin-created modules share the generic `Record` table, so creating a module
needs no DDL.

`StorageResolver` hides the difference. **Nothing outside that file may know
which is which.** If a caller branches on module slug, that branch is a bug.

---

## Security rules that are not negotiable

- **`scopeFilter` is applied in the repository layer, never in a controller.**
  A controller can be forgotten. Fail closed: no permission row means
  `{ id: { in: [] } }`, never `{}`.
- **Hidden fields are stripped on serialisation.** Hiding a field in the UI is
  not a security control — it must never leave the server.
- **The filter compiler never string-concatenates SQL.** The filter tree is
  user input. Values travel as Prisma parameters.
- **An unknown field key throws.** Silently dropping a filter condition widens
  a result set, which can leak records past a permission scope.
- **Raw webhook payloads are persisted before parsing.** No lead or account
  event is ever lost to a validation error; every event is replayable.

---

## Statuses: read the tag, never the name

Statuses are fully Admin-editable — create, rename, recolour, re-tag, reorder,
delete. So system behaviour keys off `StatusTag`, never off the string.

```ts
if (status.name === 'Converted')      // ✗ breaks the moment someone renames it
if (status.tag === 'CONVERTED')       // ✓
```

Same for `SIGNED_UP`. Nothing in application code may reference a seeded status,
picklist option or field label by name.

---

## UI rules

- **The Figma file is the authority on layout.** `Zoho.fig` is committed at
  `tools/figma/Zoho.fig`; measure it with `tools/figma/inspect.js` rather than
  recalling it. `docs/DESIGN-SPEC.md` records what has been measured.
- **Overlay sizes come from the file, not from a rule.** It draws three:
  centred pop-ups at **511** wide (Save Filter, Delete Saved Filter, Edit Name,
  Apply Auto Mapping, Assign Default Value, unsaved-changes guards), **1015**
  (Create New Fields), and **1152** (the import stage panels, which sit in the
  page rather than over it). Full screen is for the big authoring surfaces the
  file does not draw — field builder, layout editor, roles matrix, review queue.
  *This replaces the earlier "no small modals anywhere" rule, which the file
  contradicts. Superseded 22 Aug 2026 on the client's instruction to follow the
  Figma strictly.*
- **The record form is a PAGE, not an overlay** — `/[moduleSlug]/new` and
  `/[moduleSlug]/[recordId]/edit`. Measured 26 Aug 2026: the six
  `CRM _ Leads_Create Leads` frames draw the sidebar (256) and the top bar
  (1184x68) around the form, with the title in the top bar at @286,21, so an
  overlay would cover chrome the file shows. The layout is measured too —
  a 1152 content wrapper, section headers at 16px Semi Bold with a collapse
  chevron, a full-width rule under each, and **four 273-wide columns at a 12px
  gap** across 1128; actions sit ABOVE the form on the right (400x38: 132 + 12 +
  122 + 12 + 122) with the save state on the left. The file draws no sticky
  footer and no section navigator, so the form has neither.
  *This corrects the line above, which listed the record form as full-screen on
  the assumption that the file did not draw it. It does.*
- **Import is a PAGE, not an overlay** — `/[moduleSlug]/import`, with the
  sidebar and top bar in place, a five-chip stage strip, and a 1152-wide panel
  whose height changes per stage.
- **Zoho CRM is the functional reference.** The client's team works in Zoho
  daily; the target is zero retraining.
- **Every interactive element carries `data-track`**, named
  `module.screen.element.action` — e.g. `leads.list.row.open`. The interaction
  logger is a single delegated listener; per-component instrumentation would be
  forgotten.
- **Unbounded content:** overflow columns scroll horizontally with the title
  column pinned left and actions pinned right; rows and columns virtualised;
  long labels truncate with a tooltip and never wrap; long forms scroll with a
  sticky section navigator, never a squeezed grid.
- **Never hardcode a colour or spacing value.** Everything comes from
  `tokens.css`, generated by `npm run figma:tokens`.

---

## Hosting & portability

Postgres is Supabase today (session-mode pooler, `ap-southeast-1`) and moves to
self-managed Vultr later. Full plan and rationale: `docs/SUPABASE-MIGRATION.md`.

- **`db:migrate` and `db:push` are LOCAL ONLY.** `tools/guard-local-db.js`
  refuses any non-localhost target. Hosted databases get `db:deploy`, which
  applies committed migrations and never resets.
- **Every migration that creates a table must `ENABLE ROW LEVEL SECURITY` on
  it.** The blanket enable in `20260818160000_rls_enable` snapshotted the
  tables that existed then; it does not cover new ones. The invariant to hold:
  no table in `public` other than `_prisma_migrations` has `rowsecurity` false.
- **Nothing may name a Supabase-only surface** — no `supabase-js`, no
  `auth.users` FK, no pg_cron schedule, no PostgREST. None of it survives
  `pg_dump --schema=public`, so each one is a silent data-loss trap at cutover.
- **Tables are owned by `crm_app`, never `postgres`.** Ownership is fixed at
  CREATE TABLE time; changing it later needs `REASSIGN OWNED` plus re-pointing
  every connection string.

---

## Files: store ids, never URLs

`FILE` and `IMAGE` fields store an `AttachmentRef` — `{ attachmentId, name,
size, contentType }` — and resolve bytes through the `Attachment` table.

**Never store a provider URL in a field value.** `AuditLogger.diff()` writes
raw field values into `AuditLog.changes`, and invariant 2 forbids ever
UPDATEing that log. A URL written into a field diff can never be corrected, so
a bucket move or a provider change leaves the timeline pointing at dead objects
with no legal code path to fix it. An id survives all of it.

For the same reason a superseded attachment is **soft-deleted with its bytes
retained** — an older diff still references that id. Orphan collection must
exclude any `objectKey` reachable from `AuditLog.changes`.

---

## Logging layers — do not conflate

| Layer | Written by | Volume | Rule |
|---|---|---|---|
| `AuditLog` | `RecordService`, every mutation | low | append-only, forever |
| `ActivityLog` | business events | medium | 2 years |
| `InteractionLog` | client event bus | **~3.6M/month** | batched via worker only |
| `ConfigChangeLog` | every admin config write | low | with before/after + undo |

`InteractionLog` is the one that can take the system down. Client buffers →
`POST /api/logs/batch` every 5s or 25 events → BullMQ → bulk insert into a
monthly partition. **Never one request per click. Never blocking. Never in the
same transaction as business data.**

Never log passwords, tokens, payment details, keystrokes or mouse movement.

---

## Layout

```
apps/web/      Next.js — UI + route handlers (thin adapters only)
apps/worker/   BullMQ — ARK webhook, campaign intake, logs, imports
packages/core/ ENGINES. Framework-agnostic. Zero Next imports.
packages/records/ THE RECORD ENGINE — records, assignment, config writes,
               audit sink. Runtime-agnostic: web AND worker both import it.
packages/db/   Prisma schema + client + seed
packages/shared/ Types + Zod validation, used by web AND worker
tools/figma/   .fig decoder → tokens, component specs
```

Background work never runs in a route handler. Engine logic never imports Next.

**Nothing in `packages/` may import `server-only`.** That package throws
outside a Next server bundle, so one line of it anywhere in the write path
means the worker cannot create a record — and a worker that cannot create a
record has to reimplement the write path, which is how the five invariants get
broken quietly. The guard belongs on the Next side: `apps/web/src/lib/**`
carries thin `server-only` shims that re-export the package, so nothing reaches
a client bundle and the engine stays importable from a job.

---

## Commands

```bash
npm run db:migrate     # apply schema changes
npm run db:seed        # idempotent, safe to re-run
npm run typecheck      # strict, with noUncheckedIndexedAccess
npm run figma:tokens   # regenerate tokens.css from the .fig
node tools/check-schema.js packages/db/prisma/schema.prisma
```

---

## Definition of done

A feature is not done until **all** of these hold:

- [ ] No module-specific code was added to any engine
- [ ] The equivalent config change needs no migration and no deploy
- [ ] Validation is defined once, in `packages/shared`
- [ ] It writes to the correct log layer
- [ ] Permissions are enforced in the repository layer
- [ ] Every interactive element has `data-track`
- [ ] Deletes are soft
- [ ] It opens as a full-screen overlay, not a modal
- [ ] Status logic reads `tag`, never `name`
- [ ] Designed screens pass visual regression >98%

---

## Open items — ask, don't assume

- ARK webhook spec: payload fields, auth, retry behaviour *(blocks the conversion pipeline)*
- UI/UX screenshots beyond the six Figma screens *(blocks frontend beyond Leads)*
- Currency: INR only, or multi?
- SEBI log-retention obligation *(assuming 7 years, cold archive)*
- Deal handover rule default: which user, role or pool?
