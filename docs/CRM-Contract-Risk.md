# Contract Risk Note — "No developer required"

**Not legal advice.** I'm not a lawyer and you should run this past one if the contract value justifies it. This is an engineer's read of where the technical risk sits and how to reduce it.

---

## The situation

You have a signed contract containing a commitment that the client will never need a developer. No software on earth satisfies that clause read literally — including Zoho, Salesforce, and every no-code platform ever shipped. All of them require developers for integrations, hosting, patches, and bugs.

**Two things work in your favour:**

1. **Commercials are still being negotiated.** That is live leverage. A scope annexure attached during negotiation is a normal, non-adversarial thing to add — far easier than renegotiating a settled contract later.
2. **Path B is a genuinely strong defence.** If the client ever raises the clause, "you can create modules, fields, layouts, roles, permissions, workflows and integrations yourself, without us" is an overwhelmingly good-faith answer. Most disputes over clauses like this arise because the vendor delivered something rigid. You won't be.

---

## Step 1 — get the exact wording

Everything depends on the specific sentence. These are very different obligations:

| Wording | Risk |
|---|---|
| "…without requiring developer intervention **for configuration changes**" | **Low.** Path B delivers exactly this |
| "…the Client shall be able to modify fields, forms, and workflows without developer support" | **Low.** Scoped to config. Path B delivers it |
| "…the Client shall not require any developer support post-delivery" | **High.** Read literally, unsatisfiable |
| "…the platform shall be fully self-service" | **Medium.** Vague enough to be argued either way |

Send me the clause and I'll tell you precisely which capabilities have to exist to satisfy it. Often the answer is "we need three more things in the config surface," which is cheap.

**Also check for:** a definitions section (does "developer support" get defined?), a separate maintenance/support clause (hosting and bug-fixing usually live there, and if so they're already carved out), acceptance criteria, and the warranty period.

---

## Step 2 — attach a scope annexure during the current negotiation

Not a walk-back. A **specification** of what the commitment means in practice — which reads as diligence, not retreat. Structure it as two lists:

**Client-configurable, no developer, forever:**
Fields (create/edit/delete/reorder, 14 types) · picklists and their colours · conditional field logic · form sections and layout · list columns, widths, ordering, pinning · saved and shared views · per-role default views · roles and departments · permission matrix including field-level access · record scope rules · assignment rules · workflow automations · notification and escalation rules · deal stages and pipelines · webhook sources and payload mapping · import mappings · export definitions · email and message templates · branding and labels · **entirely new modules** with their own fields, forms, lists, detail pages, timelines and permissions · enabling, disabling, renaming and reordering modules

**Covered by the separate maintenance and support agreement:**
Hosting, uptime, backups · security patches and dependency updates · defect resolution · performance tuning as data volume grows · new third-party API integrations beyond the generic webhook framework · new field *types* beyond the supported set · changes to core structural relationships

That second list is not you clawing back scope — it's the industry-standard boundary, and framing it as *"here's what your ongoing support agreement covers"* turns an awkward conversation into an upsell.

---

## Step 3 — engineer the risk down

Three deliberate investments make the clause substantially safer. All are worth doing anyway:

**Widen the integration surface (≈2 days).** The highest-probability future request is "connect it to X." A generic outbound-webhook builder plus a REST connector with admin-configurable auth, endpoint, payload template and response mapping converts most future integration requests from developer work into admin work. This single item removes the largest category of risk.

**Ship more field types than you need (≈1 day).** Every missing type is a potential developer call. Add rating, percent, formula, auto-number, geolocation and signature to the core 14 now, while the renderer is fresh.

**Build the config-change audit and undo (already planned).** When a client says "it broke and we need a developer," being able to show that an admin disabled a field at 4:12pm on Tuesday and offer a one-click revert ends the conversation immediately. This is your single best operational protection.

---

## Step 4 — set the relationship up correctly

Propose an **annual support and platform agreement** alongside the build. This is the clean commercial answer: the client isn't paying for developers *on demand*, they have a support relationship — which is what they actually want when they say "we don't want to depend on developers." What they fear is being held hostage for a two-day change at an unpredictable price, not the existence of engineers.

Reframed that way, the clause stops being adversarial: *"You'll never wait on us to change a field, add a module, or adjust permissions — that's yours. And for the platform underneath, you have a support agreement so there's no surprise invoice."*

---

## What I need

1. **The exact clause text.** I'll map it to specific required capabilities.
2. Whether a **separate maintenance/support agreement** exists or is contemplated.
3. Whether there are **acceptance criteria** tied to this clause — if delivery sign-off depends on it, that changes what we build first.
