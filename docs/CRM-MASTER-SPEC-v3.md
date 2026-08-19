# Trade Bazar CRM Platform — Master Specification

**v3.0 · 18 August 2026 · Supersedes all prior documents**

Consolidates: verbal brief · Figma file (`Zoho.fig`, 64,929 nodes decoded) · your Phase 1 Planning Document · all decisions since.

---

## 0. Locked decisions

| Decision | Answer |
|---|---|
| Framework | **Next.js 15** (App Router, self-hosted Node) + separate BullMQ worker |
| Database | Postgres 16 + Prisma |
| Storage | **Hybrid** — real tables for core modules, unified `records` table for admin-created modules |
| Auth | JWT access + refresh, single tenant, Admin-created accounts and passwords |
| Permissions | **Phase 1**, full matrix + view scopes + special permissions |
| Deals | Separate entity, permanently linked to its lead |
| Conversion | **Webhook-driven only.** No manual Convert button |
| Ownership | **Closed By** (immutable) and **Deal Owner** (transferable) are separate |
| Assignment | Round-robin within **Groups**. Nothing is ever unassigned |
| Duplicates | **Flagged for review.** Never blocked, never auto-merged |
| Ingestion | **Integrately** for campaign leads · **ARK Terminal posts direct** |
| Field/status seed | Figma set as authoritative, **union** with the planning doc, all fully editable |
| UI rule | **Full-screen overlays everywhere.** No small modals, anywhere |
| Builders | Drag-and-drop field builder and layout editor |
| Benchmark | Zoho CRM — team works in Zoho daily, target is zero retraining |
| Phase 1 | **~30 working days** |

---

## 1. Prime directive

> Fields, forms, layouts, statuses, roles, departments, groups and permissions are **data**, created and edited from the UI. Never hard-coded.
>
> **Nothing is ever unassigned.** Every lead and every deal has an owner from the second it enters the system.
>
> **Everything is logged.** One append-only audit log. That log *is* the timeline shown on every record.
>
> **Admin holds the keys first.** Account creation, password resets and destructive powers start with Admin, who delegates via the permission matrix.

If adding a customer-visible option would require a code change, a migration or a deploy, the design is wrong.

---

## 2. Repository

```
apps/
  web/          Next.js — UI + route handlers
  worker/       BullMQ consumers: ARK webhook, campaign intake, logs, imports
packages/
  core/         ENGINES. Framework-agnostic. Zero Next imports.
  db/           Prisma schema + client
  shared/       Types + Zod validation, used by web AND worker
tools/
  figma/        .fig decoder → tokens, component specs, layout specs
```

Background work never runs in route handlers. 3.6M log events/month, ARK webhook bursts and multi-megabyte imports belong in the worker.

---

## 3. Storage architecture — hybrid

### 3.1 Core modules get real tables
`users` · `leads` · `deals` · `deposits` · `campaigns`

Each: **system columns** (indexed, foreign-keyed, what the platform depends on) + **`custom JSONB`** (every Admin-created field, validated against `field_definitions` on save, GIN-indexed).

### 3.2 Admin-created modules share one table
`records` — discriminated by `moduleId`, promoted generic columns + `data JSONB`.

This is what keeps module creation a no-developer operation while the high-volume core keeps real indexes and foreign keys.

### 3.3 The engine hides the difference
`RecordService` resolves a module slug to either a dedicated repository or the generic one. **No caller ever knows which.** Every engine, every API route and every component works identically against both.

---

## 4. Dynamic field engine

### 4.1 Field types (20)
`single_line · multi_line · email · phone · number · decimal · currency · percent · dropdown · multi_select · language_picker · date · date_time · checkbox · toggle · url · file · image · user_lookup · record_link`

Plus derived: `formula · autonumber` (computed, read-only).

### 4.2 Definition carries
`label · key · type · options · validation · isRequired · isUnique · isSystem · isIndexed · section · displayOrder · defaultValue · helpText · createdBy`

### 4.3 Editability rules
- **System fields** (owner, status, source, phone, name, language, created date…) must always exist — assignment, webhook matching and logging break without them. Admins can **rename, restyle, move and reorder** them, but **not delete** them.
- **All other fields** — default or Admin-created — are fully editable and deletable. Deletion is **soft**: the field disappears from forms, historical values remain stored and visible in the timeline.
- **Field edits are themselves logged** — who added, renamed or removed a field, and when.
- A field flagged `isIndexed` gets a Postgres expression index built on its JSONB path by a background job.

### 4.4 Builders
Both are **drag-and-drop**, both open **full-screen**, both apply instantly, both are logged:
- **Field builder** — compose a module's fields from a palette of types
- **Layout editor** — sections, field order, visibility, required toggles, for **both the form and the detail page**

---

## 5. Profile module

### 5.1 Roles
Only **Admin** ships — every permission on, visible in the roles screen but **locked** (cannot be edited, weakened or deleted). Every other role is created by the Admin: Telesales, Seniors, Floor Managers, Back Office, anything.

**Permission matrix** — per role, per module:

| | View scope | Create | Edit | Delete |
|---|---|---|---|---|
| Leads | None / Own / Group / Department / All | Y/N | Y/N | Y/N |
| Deals | None / Own / Group / Department / All | Y/N | Y/N | Y/N |
| Campaigns | None / Own / Department / All | Y/N | Y/N | Y/N |
| Profile (users) | None / Own / Department / All | Y/N | Y/N | Y/N |

**Special permissions** (granted per role, independent of the matrix):

Reassign leads · Transfer deal ownership · Manage fields & layouts · Manage statuses · Manage users & roles · Manage departments & groups · Manage campaigns · Import / Export · Bulk operations · View audit logs

### 5.2 Departments
Created freely (Sales, Back Office, Compliance…). Each user belongs to **one**. Acts as a view-scope boundary and a filter across the CRM.

### 5.3 Groups
Freeform, typically language teams (Hindi, English, Arabic…). A user belongs to **multiple** groups.

**Groups are the backbone of assignment**: campaign leads round-robin inside the matching language group; unmatched ARK leads go to the Seniors of that language. Managed from the Groups sub-module with add/remove member controls.

### 5.4 Users — default fields
All editable; `*` = system field, cannot be deleted.

| Field | Type |
|---|---|
| Full Name `*` | Single line |
| Email (login) `*` | Email — unique |
| Phone | Phone |
| Role `*` | Dropdown (from Roles) |
| Department | Dropdown (from Departments) |
| Groups | Multi-select (from Groups) |
| Languages Spoken | Language picker (multi) |
| Employee ID | Single line |
| Reporting Manager | User lookup |
| Status (Active/Inactive) `*` | Toggle |
| Date of Joining | Date |
| Profile Photo | Image upload |

### 5.5 Accounts & security
Account creation, password resets and deactivation are **Admin-only at launch**, delegable later via *Manage users & roles*. Deactivated users keep their history; **the system prompts for a reassignment target for their open leads**.

---

## 6. Leads module

### 6.1 Two sources, one list
Every lead carries a permanent, immutable **Source** stamp. Both types live in one unified list.

| Source | Arrives via | Routes to |
|---|---|---|
| **Campaign** | Integrately (Facebook Lead Ads, Google, landing pages), CSV/XLSX import, manual entry | Round-robin within the matching **language group** |
| **ARK Terminal** | Account-creation webhook, posted direct by ARK | Round-robin among **Seniors** of that language |

Campaign leads link to a **Campaign record** (name, platform, details) so performance is comparable campaign-by-campaign and platform-by-platform.

### 6.2 Default lead fields
Union of the Figma design and the planning document. `*` = system field. All others deletable; all renameable and reorderable.

**Lead Information** — Full Name `*` · Phone (Primary) `*` *(normalised, primary matching key)* · Alternate Phone · WhatsApp No. · Email · Language `*` *(drives assignment and matching)* · Country / City · Location · Source `*` *(Campaign / ARK Terminal, immutable)* · Campaign · Referral Code · Lead Category · Contact Method · Salutation · Amount · Status `*` · Owner `*` *(never empty)* · Group *(auto-set from language group, editable)* · Department · Notes · Created / Last Contacted `*`

**Personal Information** — Gender · Date of consent by Customer

**ARK Information** — ARK User Name · ARK Account Number *(auto-filled by webhook)* · Account Open Date · FTD Date Time · Preferred Market · Current Platform · When To Trade · Issue · Last Terminal Activity Date · Cold Date

### 6.3 Statuses & tags
The **tag** tells the system and the reports what a status *means*, so renaming never breaks reporting.

| Status | Tag | Meaning |
|---|---|---|
| New | Neutral | Just entered, untouched |
| No Answer / Attempted | Neutral | Tried, not reached |
| Contacted | Warm | Spoke at least once |
| Follow-Up Scheduled | Warm | Next call planned |
| Demo Request | Warm | Demo requested |
| Interested | Hot | Actively considering |
| RM-Not Active | Cold | Assigned RM inactive |
| Signed Up | Hot | Account created on ARK (auto-set by webhook) |
| Account Opened | Hot | ARK account confirmed |
| Telesales Account Opened | Hot | Opened via telesales |
| Not Interested | Lost | Declined |
| Wrong / Invalid Number | Invalid | Unreachable data |
| Converted | Converted | Deposit received — deal created (system-set) |

**Every one of these is editable.** The Admin can rename, re-colour, re-tag, reorder, delete and create statuses freely. This table is seed data, not code. Only `Converted` and `Signed Up` carry system behaviour, and even they can be renamed — the *tag* is what the system reads.

### 6.4 List view
Zoho-style: filter on any field, saved views, keyword search, column chooser, sorting, bulk actions (bulk status change, bulk reassign) for permitted roles.

### 6.5 Detail page & timeline
Full-screen record view: information panel left, **timeline centre**, notes and quick actions right. The timeline is the audit log rendered chronologically — entry into the system and from which source, every assignment and reassignment, every status change, every field edit (before → after), each with actor and timestamp.

### 6.6 Duplicate handling
An incoming lead matching an existing lead or deal on **phone** (or strongly on **name + language**) is **created but flagged for review**. Nothing is blocked. Nothing auto-merges.

A **review queue** lists flagged pairs side by side; a permitted user resolves each — keep both, or merge manually.

### 6.7 Assignment (Phase 1)
- **Campaign leads** → matched to the language group → round-robin among that group's active users. No group for the language → default pool → Admin.
- **Unmatched ARK leads** → round-robin among users holding the **Senior** role for that language → fallback default pool → Admin.
- **Manual assign / reassign** — single and bulk, for roles with *Reassign leads*. Every reassignment logs old owner → new owner.
- **A lead is never unassigned, even for a second.**

Implement behind an `AssignmentStrategy` interface. Phase 2's rules engine becomes a second implementation — no rework of Leads.

---

## 7. ARK Terminal webhook & conversion

ARK posts a webhook for **every account created**. This is the **only** conversion path — there is no manual Convert button.

1. **Receive & store raw** — payload written to `webhook_events` before anything else. No account event is ever lost; any event is replayable.
2. **Parse** — account number, name, phone, language, deposited amount.
3. **Match** — search **Deals first**, then active **Leads**, by normalised **phone**, verified against **name + language**.
4. **Act** — one of four outcomes below.
5. **Log** — every step written with actor `System (ARK Webhook)`, appearing on the record's timeline.

| Outcome | System does |
|---|---|
| **Existing deal matched** (re-deposit) | Adds a deposit row · updates Total Deposited and Deposit Count · logs on the deal timeline. **No new deal** |
| **Lead matched, deposit present** | Auto-fills ARK Account Number + deposited amount → **creates the Deal** → lead status becomes Converted and leaves the working list. *This is the conversion moment* |
| **Lead matched, account only** (no deposit) | Fills ARK Account Number, auto-sets status to Signed Up. Stays a lead; the agent keeps working it until a deposit arrives |
| **No match** | Creates a new Lead (Source = ARK Terminal, with referral info), round-robin among the **Seniors** of that language |

**Match confidence:** exact phone + name agreement processes automatically. A phone hit with a conflicting name (or vice versa) is processed **and flagged for review**, consistent with duplicate handling.

### 7.1 Deal creation & handover
The new deal carries **two separate relationships**:

- **Closed By** — the telesales agent who owned the lead at conversion. **Immutable. Permanent credit — this is what performance reports count.**
- **Deal Owner** — who handles the customer from now on. Set by an Admin-configurable **handover rule** (a specific user, a role such as Back Office, or a round-robin pool). Defaults to Admin until configured, so no deal is ever unowned. Transferable any time by roles with *Transfer deal ownership* — every transfer logged.

---

## 8. Deals module

A Deal is its own entity, permanently linked to its originating lead. **It inherits the lead's entire timeline** and continues logging on top — one unbroken history from first touch to every deposit.

### 8.1 Default deal fields
`*` = system field.

Linked Lead `*` · ARK Account Number `*` · Closed By `*` · Deal Owner `*` · FTD Amount / FTD Date · Total Deposited / Deposit Count *(auto-maintained)* · Deal Status `*` · Language `*` *(carried from the lead)* · Campaign of origin · Notes · Created `*` *(timestamp of conversion)*

Deals use the same dynamic engine — the Admin can add any further fields (platform, account type, KYC status…) through the form builder.

### 8.2 Deal statuses (seed, fully editable)
New FTD · Active · Re-Deposited · Dormant · Withdrawn · Closed

### 8.3 Deposit history
Every deposit — the FTD and every re-deposit arriving by webhook — is **its own row** (amount, date, source event). The deal shows the full deposit table. **Totals are always derived from rows, never typed by hand.**

### 8.4 Views
List and detail mirror the Leads UX, plus deposit-based filters: FTD date range, deposit amount range, deal status, Closed By, Deal Owner, language, campaign of origin.

---

## 9. Campaigns module

Campaign records: name, platform, details, tracking parameters. Campaign leads link to one. Powers campaign-by-campaign and platform-by-platform performance comparison, plus basic campaign analytics (leads in, conversion rate, total deposited, cost per conversion if spend is entered).

---

## 10. Filter & search engine

Every field is filterable and searchable **automatically**, including fields created after launch. Operators derive from the field's type — never configured by hand.

| Type | Operators |
|---|---|
| text, email, url, multi_line | is · is not · contains · does not contain · starts with · ends with · is empty · is not empty |
| number, decimal, currency, percent | = · ≠ · > · < · ≥ · ≤ · between · not between · is empty |
| date, date_time | on · before · after · between · not between · last N days · next N days · today · this week · this month · is empty |
| dropdown, multi_select, language_picker | is · is not · is any of · is none of · is empty |
| checkbox, toggle | is checked · is not checked |
| user_lookup, record_link | is · is not · is any of · is me · is empty |

**Filter tree** — arbitrary AND/OR nesting, compiled to a parameterised Prisma `where`. Never string-concatenated; the tree is user input.

Also: **cross-module global search** (Postgres `tsvector`, permission-scoped, results grouped by module) · per-module quick search · **saved views** (filter + columns + sort, private or shared, settable as a role default, with live match counts) · related-record filters · export respects the active filter and visible columns.

**Performance:** estimated counts above a threshold; cursor pagination beyond page 50.

---

## 11. Permission engine

Single choke point — every read and write passes through it:

```
can(user, action, moduleSlug, record?)   → boolean
scopeFilter(user, moduleSlug)            → Prisma where clause
visibleFields(user, moduleSlug)          → FieldDefinition[]
```

`scopeFilter` is applied in the **repository layer**, not the controller, so it cannot be forgotten. Field restrictions apply on serialisation — a hidden field never leaves the server.

Scopes: `None · Own · Group · Department · All`.

---

## 12. Logging & timelines

**One append-only audit log** records every action: record created, field edited (before → after), status changed, lead assigned/reassigned, deal ownership transferred, deposit received, field/layout/status definitions changed, user logins, admin actions.

Each entry stores: entity · actor · action · diff · timestamp. Actor may be a system identity — `System (ARK Webhook)`, `System (Round Robin)`.

**Timelines are the log, rendered per record.** Nothing stored twice, nothing drifts out of sync, nothing can be edited away.

### 12.1 The four layers

| Layer | Captures | Volume | Retention |
|---|---|---|---|
| **Audit** | Every data mutation, before → after | Low | Forever |
| **Activity** | Business events per user | Medium | 2 years |
| **Interaction** | Every click, view, search, filter, sort, export | **~3.6M/month** | 90d hot → cold archive |
| **Config change** | Every configuration write, with undo | Low | Forever |

### 12.2 Interaction pipeline
Delegated `data-track` listener → client buffer → `POST /api/logs/batch` every 5s or 25 events → BullMQ → bulk insert into a **monthly partition**.

**Never one request per click. Never blocking. Never in the same table as business data.**

Naming: `module.screen.element.action` — e.g. `leads.list.row.open`, `admin.fields.create.submit`.

**Never log:** passwords, tokens, payment details, keystrokes, mouse movement. Redact client-side.

### 12.3 Viewers (Phase 1)
Record timeline · permission-gated Admin log viewer searchable by user, module, action and date · user activity view · CSV export.

---

## 13. Guardrails

| Guardrail | Behaviour |
|---|---|
| Dependency check | Before deleting a field or status: scan views, filters, automations, layouts, imports. Show what breaks. Confirm |
| Last-admin protection | The final user with Admin rights cannot be removed or deactivated |
| Soft delete everywhere | Fields, options, statuses, records, modules. One-click restore |
| Deactivation prompt | Deactivating a user prompts for a reassignment target for their open leads |
| Required-field warning | Warn past 8 required fields on one form |
| Column warning | Warn past 15 visible columns |
| Field cap | Soft warn at 100/module, hard cap 250 |
| Status-in-use | Deleting a status in use requires choosing a replacement for existing records |
| Config undo | Every config change diffed and revertible in one click |
| Preview mode | Layout changes previewable before publishing |

---

## 14. UI / UX rules

- **Zoho CRM is the direct functional reference.** The team works in Zoho daily; navigation, list views, record pages and behaviours should transfer with **zero retraining**.
- **Full-screen overlays everywhere.** Every create/edit form, the field builder, the layout editor and the review queue open full screen. **No small popups anywhere in the product.**
- **Exact visual detail** matched to the Figma and to the UI/UX screenshots to be provided before frontend build starts.
- **Unbounded content rules** (not in the Figma — decided here): overflow columns scroll horizontally with the title column pinned left and actions pinned right; rows and columns virtualised; long labels truncate with tooltip, never wrap; long forms scroll with a sticky section navigator, never a squeezed grid.

---

## 15. Design pipeline

The `.fig` decoder in `tools/figma/` works. Hand-transcribe nothing.

1. **Tokens** — `tokens.css` + Tailwind theme generated from the Figma variable sets *(49 tokens already extracted)*
2. **Primitives** — from the "Internal Only Canvas" page: Buttons, Input Form, Dropdown Item, Menu Item, Icons
3. **Layout specs** — auto-layout → flexbox per designed frame
4. **Visual regression** — Figma frame PNG vs built page at 1440px, target >98%

Six screens exist in the Figma (Leads list, sort, filter, saved filters, create, import). Everything else composes from the same primitives. **Desktop 1440px only** — no mobile frames exist. ⚠️ Confirm acceptable.

---

## 16. Build order — 30 days

| Days | Slice |
|---|---|
| **1–2** | Monorepo, Prisma schema, auth, JWT, login. Figma token + primitive extraction |
| **3–6** | **Foundation**: field engine, layouts, statuses + tags, audit log. Drag-and-drop field builder and layout editor. Full-screen overlay shell |
| **7–9** | **Permissions**: roles, matrix, view scopes, special permissions, repository-layer scope filters |
| **10–12** | **Profile**: departments, groups, dynamic user form, deactivation flow |
| **13–16** | **Record engine + Leads core**: hybrid storage resolver, list view, virtualisation, column config, detail page, timeline, manual + CSV/XLSX capture |
| **17–19** | **Filter & search**: operator registry, AND/OR tree compiler, saved views, cross-module search |
| **20–21** | **Campaign intake**: Integrately endpoint, mapping UI, replay, Campaign records, duplicate flagging + review queue |
| **22–23** | **Assignment**: groups round-robin, Senior routing, default pool, manual and bulk reassign |
| **24–25** | **ARK pipeline**: webhook receiver, matching, four outcomes, auto-fill, auto-conversion, handover rule |
| **26–27** | **Deals**: entity, inherited timeline, deposits table, statuses, deposit-based views, campaign analytics |
| **28** | **Logging layers 2–4**: activity, interaction batching, config change, partitioning, viewers |
| **29** | **Guardrails** + import wizard completion |
| **30** | Seed data, visual regression pass, QA |

**Weekly demos:** wk1 login + field builder · wk2 permissions + Profile · wk3 Leads live with filters · wk4 campaign intake + assignment · wk5 ARK conversion + Deals · wk6 logs, guardrails, polish.

---

## 17. Definition of done

- [ ] No module-specific code in any engine
- [ ] The equivalent config change needs no migration and no deploy
- [ ] Validation defined once, in `packages/shared`
- [ ] Writes to the correct log layer
- [ ] Permissions enforced in the repository layer
- [ ] Every interactive element has `data-track`
- [ ] Soft delete, not hard
- [ ] Opens as a full-screen overlay, not a modal
- [ ] Designed screens pass visual regression >98%

---

## 18. Open items

**Blocking a slice:**
- **ARK webhook technical spec** — payload fields, authentication, retry behaviour. *Needed before day 24*
- **UI/UX screenshots** beyond the Figma. *Needed before frontend build*
- **Campaign platforms** to connect first via Integrately
- **Deal handover rule** default — which user, role or pool

**Not blocking:**
- Currency — INR only, or multi?
- Data volume today and monthly inflow
- SEBI log-retention obligation (assuming 7 years, cold archive, unless told otherwise)
- Desktop-only acceptable?
- Dashboard / Contacts / Calls — you said Phase 1.5; absent from the planning doc. Still wanted?
- Exact contract wording on the "no developer" clause

---

*Sources: `Zoho.fig` (64,929 nodes, 11 pages, decoded locally) · CRM Phase 1 Planning Document v1.0 · project conversation 18 Aug 2026.*
