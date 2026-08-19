# Gap Analysis — your Phase 1 Planning Doc vs. my spec

Your PDF is more detailed than the verbal brief in several important places. Below: what I was missing, what conflicts, and what needs your decision.

**Nine things need a decision from you.** They're marked ⚠️ and collected at the end.

---

## PART A — Major things I did not have

These are real gaps. All go into the spec.

### A1. Groups — an entire concept I was missing
Your doc: **Groups** are freeform (typically language teams — Hindi, English, Arabic), a user can belong to **multiple** groups, and **groups are the backbone of assignment**.

I modelled `language` as a single scalar on the user and routed on that directly. That's wrong. The correct model:

- Users have **Languages Spoken** (multi-select) *and* belong to **Groups** (multi-select)
- Leads carry a **Group** field, auto-set from the language group, **editable**
- Round-robin happens *within a group*, not across a language string
- "Group" is also a **view scope** — `None / Own / Group / Department / All`

This is a meaningfully different data model and it affects the assignment engine, the permission engine, and the user form.

### A2. Two lead sources with different routing rules
Every lead carries a permanent, immutable **Source** stamp — **Campaign** or **ARK Terminal** — and both live in one unified list.

| Source | Arrives from | Routes to |
|---|---|---|
| **Campaign** | Facebook Lead Ads, Google, landing pages, CSV, manual | Round-robin within the matching **language group** |
| **ARK Terminal** | Account-creation webhook (usually referrals) | Round-robin among users holding the **Senior** role for that language |

I had one generic ingestion path. Two paths with different routing targets is a real difference.

### A3. Conversion is webhook-only — there is no Convert button
This is the one I got most wrong. My spec has `POST /records/:id/convert` as a user action. Your doc is explicit: **ARK sends a webhook for every account created, and that pipeline is the only conversion path.**

Five steps: receive & store raw → parse → match (Deals first, then active Leads, by normalised phone, verified against name + language) → act → log with actor `System (ARK Webhook)`.

Four outcomes:

| Outcome | System does |
|---|---|
| Existing deal matched | Adds a deposit row, updates Total Deposited + Deposit Count, logs on deal timeline |
| Lead matched, deposit present | Fills ARK Account Number + amount → **creates the Deal** → lead status becomes Converted. *This is the conversion moment* |
| Lead matched, account only | Fills ARK Account Number, status → Signed Up. Stays a lead; agent keeps working it |
| No match | Creates a new Lead (Source = ARK Terminal) and routes to Seniors of that language |

I need to delete the manual convert endpoint entirely.

### A4. Closed By ≠ Deal Owner
Two separate relationships on every deal:

- **Closed By** — the telesales agent who owned the lead at conversion. **Immutable.** This is what performance reports count.
- **Deal Owner** — who handles the customer now. Set by an Admin-configurable **handover rule** (specific user / a role like Back Office / round-robin pool). Defaults to Admin until configured. Transferable, and every transfer is logged.

I had a single `ownerId`. Losing Closed By would break commission and performance reporting — this is a significant miss.

### A5. Deposits are their own table
Every deposit — the FTD and every re-deposit arriving by webhook — is **its own row** (amount, date, source event). The deal shows the full deposit table, and **totals are always derived, never typed**.

I had a single `amount` field on the deal. Wrong shape entirely.

### A6. Campaigns — effectively a fourth Phase 1 module
Campaign records (name, platform, details) linked from campaign leads, so performance can be compared **campaign-by-campaign and platform-by-platform**. Plus "basic campaign analytics" in your build slice 6.

Completely absent from my spec.

### A7. Status *tags* — semantic meaning separate from the label
Every status carries a **tag**: `Neutral / Warm / Hot / Lost / Invalid / Converted`. The tag tells the system and the reports what a status *means*, so renaming or adding statuses never breaks reporting logic.

I had colours only. This is a genuinely good design detail and I'm adopting it — it's what lets statuses stay fully dynamic without reports going stale.

### A8. Duplicate handling — flag, never merge
Your doc: matches on phone (or strongly on name + language) are **created but flagged for review**. Nothing blocked, nothing auto-merged. A review queue shows flagged pairs side by side; a permitted user resolves each (keep both / merge manually).

I had proposed auto-merge on phone. **My default was wrong** — and this needs a `duplicate_flags` table and a review queue UI I hadn't scoped.

### A9. "Nothing is ever unassigned"
Your doc states a lead always has an owner **from the second it enters the system** — no group for the language falls back to default pool → Admin.

I built an **unassigned pool** as the fallback. That directly contradicts this principle. Yours is better for a telecalling floor; I'll remove the pool and use default-pool → Admin.

### A10. Full-screen overlays — a house UI rule
**Every** create/edit form, the field builder, the layout editor and the review queue open as **full-screen overlays**. No small modal windows anywhere in the product.

My spec used modals and drawers throughout. This is a global UI constraint I have to apply everywhere.

### A11. Drag-and-drop builders
Both the **field builder** and the **layout editor** are explicitly drag-and-drop, and layout changes apply instantly and are logged. My spec had a form-based field manager. DnD is meaningfully more work — worth about 2 extra days.

### A12. Only one role ships: Admin
Admin is seeded with every permission on, **visible but locked** — cannot be edited, weakened or deleted. Every other role (Telesales, Seniors, Floor Managers, Back Office) is created by the Admin from a permission matrix.

I seeded five roles as system roles. They should be optional seed *suggestions*, not locked rows.

### A13. Special permissions — a defined list
Independent of the module × action matrix: Reassign leads · Transfer deal ownership · Manage fields & layouts · Manage statuses · Manage users & roles · Manage departments & groups · Manage campaigns · Import/Export · Bulk operations · View audit logs.

Mine was generic. Yours is more precise and I'm taking it as-is.

### A14. Smaller items
- **Layouts cover the detail page too**, not just forms — I only had form layout
- **Deactivating a user** prompts for a reassignment target for their open leads
- Actor on a log entry can be a **system identity**: `System (ARK Webhook)`, `System (Round Robin)`
- Deal list/detail get **deposit-based filters**: FTD date range, deposit amount range, Closed By, Deal Owner, campaign of origin
- **Match confidence**: exact phone + name agreement auto-processes; phone hit with conflicting name is processed *and* flagged

---

## PART B — Direct contradictions ⚠️

These need your call. I can't resolve them by reading.

### ⚠️ B1. Lead statuses — your PDF and the Figma disagree

| Your planning doc | The Figma file |
|---|---|
| New · No Answer/Attempted · Contacted · Follow-Up Scheduled · Interested · Signed Up · Not Interested · Wrong/Invalid Number · Converted | Interested · Contacted · RM-Not Active · Demo Request · Account Opened · Telesales Account Opened |

Almost no overlap. Your PDF's set is better structured (it has the tag system and covers the full funnel). Which is real?

### ⚠️ B2. Lead fields — the two documents describe different forms
Your PDF lists ~15 lean fields. The Figma Create Lead screen has ~25 across three sections including a whole **ARK Information** section: Preferred Market, When To Trade, Current Platform, Issue, FTD Date Time, Last Terminal Activity Date, Cold Date, Account Open Date, Lead Category, Contact Method, Salutation, Amount.

Since fields are dynamic this isn't fatal — but it decides what ships seeded on day one, and the Figma's set implies UI the PDF's set doesn't.

### ⚠️ B3. Permissions — Phase 1 or Phase 2?
Your PDF puts the **full permission matrix inside the Profile module in Phase 1** (`roles / role_permissions`, view scopes, special permissions). You told me verbally that Rules/permissions are **Phase 2** and Phase 1 should use a hardcoded matrix.

The PDF is right, in my view — permissions gate everything and retrofitting them is painful. But it adds ~2 days to Phase 1.

### ⚠️ B4. Storage architecture — separate tables or one records table?
Your PDF: separate `leads`, `deals`, `users` tables, each with system columns + JSONB. *"The database stays firm. The schema never changes at runtime."*

My spec: **one `records` table** discriminated by module, so a brand-new module needs no DDL.

This matters because of what you told me afterwards — *the admin must be able to create anything, with no developer, ever*. Separate tables mean a new module requires a developer to create a table. One unified table means custom modules are free.

**Options:** (a) unified table — custom modules free, slightly less clean for the three known modules; (b) separate tables now, unified later — a migration; (c) hybrid — real tables for Leads/Deals/Users, unified table for admin-created modules. I lean (c): best performance where volume lives, full flexibility where it's needed.

### ⚠️ B5. Ingestion — Integrately, or per-platform connectors?
Your PDF: *"Webhook/API connectors per platform"* — Facebook Lead Ads, Google, landing pages, each with its own connector.
You told me verbally: **Integrately** pools everything and pushes to us.

These are different amounts of work. Integrately is far less. Has the plan changed, or does Integrately handle some sources and direct connectors handle others?

### ⚠️ B6. Import — CSV only, or the full wizard?
Your PDF says "CSV import of leads." The Figma has a **25-frame** import wizard: XLSX/CSV/VCF/XLS, charset detection, module-file mapping, auto-map, create-fields-on-the-fly, default values, dedupe strategy. That's 2 days versus about 3 hours.

### ⚠️ B7. Module 4 and 5 — Assignment & Workflows, or Automation & Rules?
Your PDF: Profile, Leads, Deals, **Assignment**, **Workflows**.
You told me: Profile, Leads, Deals, **Automation**, **Rules**.

If "Rules" meant permissions, then per B3 it's Phase 1 and Phase 2 is Assignment + Workflows. Confirm the five module names.

### ⚠️ B8. Dashboard, Contacts and Calls
You told me these are in scope for Phase 1.5. Your planning doc doesn't mention them at all, and they don't appear in your build order. Still wanted?

### ⚠️ B9. Language on the user record
Your PDF has **Languages Spoken** (multi-select) and does *not* mark it a system field. My spec locked a single `language` as one of five mandatory fields.

If assignment routes on **groups** rather than the language field (per A1), then Languages Spoken doesn't need to be locked — group membership does. Confirm that's the intent.

---

## PART C — Things I have that your doc doesn't

Confirm you still want these; each carries cost.

| Item | Cost | My view |
|---|---|---|
| Interaction logging — every click, ~3.6M events/month | 2 days | You asked for this explicitly after the PDF. Your doc's audit log is layers A+B only |
| Cross-module global search | 2 days | You asked for it. Not in the PDF |
| Full AND/OR nested filter builder | included | Your doc says "filter on any field" — mine goes further with grouped logic |
| Guardrails (dependency checks, caps, last-admin, config undo) | 2 days | Not in your doc. I'd argue essential given total admin control |
| Conditional field logic (show B if A = X) | 2 days | Not in your doc |
| 20 field types | — | Your doc lists 15. Mine adds rating, formula, auto-number, percent, geolocation |
| Figma token/component extraction + visual regression | 2 days | Your doc says screenshots will be provided separately — which suggests more design is coming that I haven't seen |

---

## PART D — What your doc resolved for me

Good news — several of my open questions are now answered:

- **Deal stages** → New FTD · Active · Re-Deposited · Dormant · Withdrawn · Closed
- **Products on a deal** → not a thing. It's deposits, not products. My "products/line items" question was the wrong question
- **Deal handover** → Admin-configurable rule, defaults to Admin
- **Re-deposits** → update the existing deal, add a deposit row, never create a new deal
- **Duplicate rule** → flag for review, never auto-merge (corrects my assumption)

Still open from both documents: currency (INR only?), data volume, SEBI log retention, ARK webhook technical spec (payload, auth, retry), and the promised UI/UX screenshots.

---

## Revised estimate

Adding groups, campaigns, deposits, the ARK pipeline, the review queue, full-screen overlays, drag-and-drop builders and Phase-1 permissions:

**Phase 1: 24 → ~30 working days** (6 weeks solo).

The additions are mostly things that would have been discovered mid-build anyway. Finding them now is much cheaper than finding them in week four.

---

## What I need

Answer B1–B9. B4 (storage architecture) is the one that must be settled before any code is written — everything else can be decided as we reach it.
