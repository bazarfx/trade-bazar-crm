# Design spec — extracted from `Zoho.fig`

Decoded locally: 64,929 nodes, 11 pages. Nothing here is hand-transcribed —
every value below was read out of the file by `tools/figma/inspect.js`.

Regenerate: see `tools/figma/README.md`. Decoded output lands in
`tools/figma/out/` which is gitignored (nodes.json is 154 MB).

---

## Colour

`apps/web/src/app/tokens.css` holds the 49 Figma variables and is generated —
verified byte-identical to a fresh extraction. Do not edit it by hand.

**The brand colour is teal `#00667a`.** Ranked by actual use across the file:

| Hex | Uses | Token | Role |
|---|---|---|---|
| `#6b7280` | 6024 | `--body` | body text |
| `#ffffff` | 4355 | `--surface` | cards, sidebar |
| `#111827` | 3887 | `--heading` | headings, strong text |
| `#f6f8fa` | 761 | `--background` | app canvas |
| **`#00667a`** | **508** | `--primary-hover` | **primary buttons, active nav** |
| `#ef4444` | 361 | `--error` | destructive |
| `#16a34a` | 174 | `--accent` | success only |
| `#007489` | 11 | `--primary` | barely used; a swatch label |

⚠️ The variable named `--primary` (`#007489`) is NOT the working brand colour.
The design uses `--primary-hover` (`#00667a`) as the resting state — 508 uses
against 11. Tailwind's `primary` maps to `#00667a` for that reason. Renaming
the variables would mean regenerating tokens from a corrected Figma file.

`#757575` is used for muted sidebar labels and is NOT in the variable set;
it is close to `--globalcolors-neutral-80` (`#727272`), which we use instead.

## Type

Inter throughout. Sizes actually used on the CRM screens, by frequency:

| Style | Use |
|---|---|
| Regular 14px | table cells, body — the default |
| Medium 14px / lh 20 | nav labels, field labels, buttons |
| Medium 12px | column headers, chips, secondary actions |
| Regular 12px | helper text, placeholders |
| Medium 10px / lh 12, ls 0.4 | overlines (`Main`, role above a name) |
| Medium 24px / ls 0.4 | page title |

## Radius

| Radius | Uses | Applies to |
|---|---|---|
| 4px | 8318 | buttons, inputs, chips — the default |
| 8px | 824 | nav links, small containers |
| 12px | 161 | panels and cards |
| 24 / 28px | 4472 | pills, scrollbar, avatars |

## Spacing

Auto-layout gaps and padding resolve to a 4px grid: 4, 8, 12, 24 dominate.
Sidebar padding is 24. Nav link padding is 10/12. Button padding is 8/12
(small, medium) or 10/10 (icon-only).

---

## Screen: CRM — Leads (1440×1024)

The reference frame. Canvas `#f6f8fa`.

### Top bar — 1184×68, over the content column
`Rectangle 2` in the frame: `x 256, y 0`, 1184×68, `bg #ffffff`, 1px bottom
border `#e5e7eb`. The **user profile lives here**, right-aligned with a 16px
margin (the group sits at x=1216 of 1440). Page content starts below this bar.

`Profil` @1216,12 — 208×44, `flex-row gap:12`:

| Node | Geometry | Style |
|---|---|---|
| `Avatar` (ROUNDED_RECTANGLE) | @0,0 44×44 | `r:36.22`, `fills:[IMAGE/FILL]` — a circle |
| `Content` | @56,4 152×36 | `flex-row gap:4` |
| ↳ `Frame 1` | @0,0 112×36 | `flex-col gap:4` |
| ↳↳ `Title` | @0,0 112×20 | Medium 14px/20, `#111827` — "Andrew Smith" |
| ↳↳ `OVERLINE` | @0,24 112×12 | Medium 10px/12 ls 0.4, `#6b7280` — "Product Manager" |
| ↳ `Icon / Chevron` | @136,10 16×16 | |

⚠️ Two corrections, both measured off this frame on 22 Aug 2026:

- **The NAME is on top and the role below it** (`Title` at y=0, `OVERLINE` at
  y=24). An earlier revision of this section had them the other way round —
  that ordering is real, but it belongs to the `Sidebar - Open` COMPONENT
  (`OVERLINE` @0,0, `Title` @0,16), not to this screen. The rule below settles
  it: when the template and a screen disagree, the screen wins.
- **The overline is `#6b7280` (`--body`), not `#757575`.** `#757575` is the
  sidebar component's muted grey; the top bar's is a token exactly.

The 16×16 chevron is drawn in the file but **not built** — it promises a
profile menu and there is none (sign-out is the sidebar's "Logout Account"
row). It goes in when there is a menu behind it.

> An earlier revision of this section placed the profile inside the sidebar
> and described no top bar — that came from the sidebar component template,
> not the real screen. The values above are measured off the `CRM _ Leads`
> frame itself. When the template and a screen disagree, the screen wins.

### Sidebar — 256 wide, full height
`bg #ffffff`, `flex-col`, `gap 24`, `padding 24`, radius 12 when floating.
Inner content width 208. Top to bottom, per the frame:

- Collapse button 28×28, radius 8, 6px padding, bordered `#f6f6f6`
- **Logo slot**: the file draws placeholder text "Logo Here", 14px Medium,
  heading colour. No logo asset exists, so the build renders the product name
  with the same typography. (The profile is NOT here — see the top bar.)
- Divider 208×1, `#f6f6f6`
- Group **Main** — a Dashboard link, then the **CRM dropdown**:
  - Parent row 208×40, radius 8: grid icon + "CRM" + trailing chevron that
    rotates while open. When any module route is current the PARENT wears
    `bg #f6f8fa` with a heading-colour label.
  - Sub-links 172×32, radius 8, 12px Medium, indented 36 from the group edge
    with a 2px vertical guide line (`#f6f6f6`) running down the left of the
    sub-list. Active sub-link `bg #f6f6f6` + heading label; resting `#757575`.
  - The sub-links ARE the module list. The file shows Zoho's set (Leads,
    Deals, Contacts, Calls); ours is `ModuleDefinition` rows ordered by
    `navOrder`, never a hardcoded list.
- Divider, then group **Settings** — the same dropdown anatomy, sub-links
  being the real settings pages.
- Bottom-pinned group (at y=912 in the frame): **Help**, then
  **Logout Account** with icon AND label in `#ef4444`.
- Nav link 208×40, `flex-row`, `gap 12`, `padding 10/12`, radius 8.
  Icon 20, label 14px Medium, `letter-spacing -2`.
  Resting label `#757575`; current item label `#000000` with `bg #f6f6f6`.
- Group heading ("Main") is a 10px Medium overline, `#757575`, padding 0/12.
- Only the expanded state is drawn. The collapsed 72px rail follows the Menu
  Item component's 40×40 icon-only variants; dropdowns flatten into their
  sub-items as icon buttons.

### Header
- Page title 24px Medium, `#111827`
- Search box 206×36, `bg #f6f8fa`, border `#e5e7eb`, radius 4,
  search icon 20, placeholder 12px Light `#6b7280` — "Search Here"
- Action buttons row, gap 12, each `padding 10/12`, radius 4, height 38:
  **Create Lead** (primary, `bg #00667a`, white label),
  **Export** and **Import** (secondary, `bg #ffffff`, border `#e5e7eb`)

### Body — two panels, 856 tall, radius 12, white, border `#e5e7eb`
- **Left filter panel, 230 wide**: "Filter by Leads" header 14px Medium, then
  three collapsible groups, each a chevron + 12px Medium label:
  *System Defined Filters*, *Filter By fields*, *Filter By Related Modules*
- **Right list panel, 910 wide**: toolbar row 1152×56 (view selector
  "All Leads", Filter, Sort, Show/Row page size), the table, a horizontal
  scrollbar (radius 24, thumb `#e5e7eb`), and Pagination centred below.

### Table columns, in file order
`Locked · Notes · Country · Latest Email Status · Deals · Amount ·
Untouched Records · Tasks · Current Platform · Lead Name · Email · Phone ·
Lead Status · Gender · Lead Category · Language · Department ·
ARK Account Number · Location`

Cells are 14px Regular. This is a COLUMN SET, not a schema: it is seeded
through `FieldDefinition` + a saved view, never hardcoded.

### Avatars — the two sizes the file draws

| Node | Where | Geometry |
|---|---|---|
| `Avatar` (ROUNDED_RECTANGLE) | top bar `Profil` | 44×44, `r:36.22`, `fills:[IMAGE/FILL]` |
| `Display Picture` (FRAME) | `Table / Base /  List` → `Content` | 24×24, `r:24`, `fills:[IMAGE/FILL]` |

Measured: only the **first** cell of a row draws the picture — the 200-wide
Lead Name cell. Every other column holds the same node with `visible: false`.
That is why `DataTableColumn.avatarKey` is per-column config rather than
"column 0 gets an avatar"; the list page sets it on the column whose key is
`ModuleDefinition.recordTitleField`.

There is no third size and no avatar stack anywhere in the file, and no
record-detail frame at all — that screen composes from these two and uses 44,
the size the file gives an avatar that identifies a whole page's subject.

Neither `User` nor `Lead` carries a photo yet (`User.profilePhoto` is a seeded
IMAGE field, but the upload path does not exist), so the faces are DEMO
imagery extracted from the .fig into `apps/web/public/figma/avatars/` and
chosen by hashing the record id — a pure function, never stored. See
`apps/web/src/components/demo-avatar.ts`.

### Saved-filter row menu

Measured on `CRM _ Leads_Filter By leads_Saved filter Edit`: a saved-filter row
(`Frame 482702`, 206×20, `bg #f6f8fa`) carries name + count badge, and ends in
`ph:dots-three-vertical-bold` 16×16 flush right at x=470 of 284…490. It opens
`Group 3` @388,236 — 98×32, two `Drop Down` rows: **Rename** then **Delete**
(resting `bg #ffffff` / `#6b7280`, hovered `bg #f6f8fa` / `#111827`). Those
two rows are drawn at 16px with 6px text, which is the whole dropdown rendered
at a reduced scale — below every step of the type scale, so the build uses the
Sort menu's measured 28px row and 10px text instead.

---

## Component: Button

Variants in the file are `Size × Hierarchy × State`.

| Size | Height | Padding | Gap | Text | Icon |
|---|---|---|---|---|---|
| Small | 32 | 8/12 | 4 | 12px Medium | 14 |
| Medium | 37–38 | 8/12 | 4–8 | 14px Medium | 16 |
| Large | 40 | 10/10 | 10 | 14px Medium | 20 |

All radius 4. Hierarchies: **Primary** (solid, white label), **Secondary**
(`#f2f2f2`/white with border), **Destructive** (`#af4b4b` text, `#f7eded` fill
or `#bf6f6f` border).

The component library draws Primary as black; every real screen instance
overrides it to `#00667a`. Follow the screens.

## Component: Menu Item

`Theme × Type × Current × State`. 224×40 expanded or 40×40 icon-only,
`padding 8/12`, `gap 12`, radius 4. Sub-items indent to `padding-left 48`.
Optional trailing badge: `padding 2/8`, radius 16, `bg #f5f5f5`.

---

## Not in the Figma — decided in `CLAUDE.md`

Only six screens exist (Leads list, sort, filter, saved filters, create,
import) and only at desktop 1440. Everything else — the field builder, layout
editor, status manager, settings — has no design and composes from the
primitives above. Overflow, virtualisation and the sticky section navigator
follow the rules in `CLAUDE.md`, not the file.

---

# The other five screens

All measured from the file the same way. Each names the engine it depends on —
several are UI over machinery that does not exist yet, and building the chrome
without it produces a screen that lies.

## Screen: Create Leads (1440×1024)

A full-screen form over the canvas. This is the record create/edit form for
EVERY module — Leads is the module whose `FormSection` + `FieldDefinition`
rows it renders.

- Title "Create {Module}"
- **Numbered sticky section navigator**, left: `1. Lead Information`,
  `2. Personal Information`, `3. ARK Information`. These are exactly the three
  seeded `FormSection` rows — the navigator is generated, never a list in code.
  This is the "sticky section navigator, never a squeezed grid" rule in
  `CLAUDE.md` made visible.
- Field rows carry: label, help text under the label, placeholder (`Enter...`,
  `Write here...`, `DD/MM/YYYY` on dates), and a `0/50` character counter where
  a max length applies.
- Section separators are full-width 1px lines `#e5e7eb`.
- Footer actions: **Save** (primary), **Save as New**, **Cancel**, plus an
  "All changes Saved" status line.

Depends on: field engine ✅, layout engine ✅, record engine ⬜ (create path).

## Screens: Sort, Filter by Leads, Saved Filters

Three states of the same list screen, not separate pages. Ten frames in the
filter section, four in the sort section, all sharing one chrome — only the
rail and the panel above the table change.

### Sort

A small dropdown, 132×56, radius 6, `bg #ffffff`, border `#e5e7eb`. Two rows
of 28px, 10px Regular text: **Descending** (`#6b7280`) and **Ascending**
(`#111827`, selected, `bg #f6f8fa`). Rows carry the bottom corner radius only.
Opens from the `Sort` toolbar button.

### The filter rail — three groups

**System Defined Filters** — computed, not module fields. From the file:
`Activities · Cadences · Campaigns · Latest Email Status · Locked ·
Record Action · Related Record Action · Touched Records · Untouched Records`,
plus an **Age in [N] Days** row with a numeric input.

⚠️ These are engine concepts, not `FieldDefinition` rows. They cannot be
generated from a module's fields and must not be faked as such — several
depend on the activity log and the campaign link. Ship the group only when the
filter engine can answer them; an inert checkbox that silently matches nothing
is worse than an absent one.

**Filter By fields** — one row per filterable field of the module, generated
from `FieldDefinition`. The operator set comes from the field's type via
`FIELD_TYPE_SPECS[type].operators` — never configured by hand, never a
per-field list in code.

**Filter By Related Modules** — `Accounts (Connected Records)`,
`Archives (Connected Records)`, `Products (Connected Records)`,
`Solutions (Connected Records)`, `Quotes (Connected Records)`, plus
`Meetings · Tasks · Emails · Connected To`. Generated from modules that link to
this one; the file's list is Zoho's module set, not ours.

### Actions and saved views

Footer of the rail: **Clear** and **Apply Filter**. Once a filter is applied a
**Save Filter** action appears, and naming it uses an **Add Name** input. Saved
views then surface as a fourth rail group, **Saved Filters (9)** with a live
count — matching spec §10's "saved views with live match counts".

#### The three pop-ups — 511 wide

All named "Pop up" in the file, so located by their title text:

| Frame | Content | Footer (two 222×40 buttons, gap 18) |
|---|---|---|
| 511×252 **Save Filter** | `Text Area` 463×70 → `Label` "Filter Name" (Regular 14px `#111827`) + `Input Base` 463×41 (pad 10/12, `bg #ffffff`, `border #e5e7eb`, `r:4`, placeholder "Enter..." `#6b7280`) | Cancel `#f6f8fa` · Save `#00667a` |
| 511×252 **Edit Name of Save Filter** | identical | Cancel `#f6f8fa` · Save `#00667a` |
| 511×203 **Delete Saved Filter** | `Label` only — "Are you sure you want to delete this filter?" Regular 14px `#111827` | Cancel `#f6f8fa` · Delete `#ef4444` |

Common shell (identical in all three, and the reason `components/ui/popup.tsx`
owns every number): `flex-col gap:24 pad:24`, `bg #ffffff`,
`border #e5e7eb 1px`, `r:8`; `Title` 463×22 `flex-row gap:16` with an
`Icon/X` 20×20 flush right, title Medium 18px `#111827`; `Separator` 463×1;
`Content` `flex-col gap:20`; footer `Frame 482701` 463×40 `flex-row gap:18`.

**Height follows content — only the width is fixed.** The same frame is drawn
at 203, 242, 252, 353 and 378 in the file. That is why the Save Filter pop-up
here is taller than 252: it carries our two publish toggles (`isShared`,
`isDefault`), which the file's own Content frame has a slot for — a
`Checkboxes Component / Checkbox` 290×24 node, `visible: false` in every
instance because Zoho's dialog has nothing to put in it.

These replace the full-screen versions per CLAUDE.md's rewritten UI rules
(22 Aug 2026). Built in
`apps/web/src/app/(app)/[moduleSlug]/_components/saved-view-popups.tsx`.

Persisted in `SavedView` (columns + filters + sort, private or shared, and a
per-role default). The filter tree is `FilterNode` from `packages/shared` and
compiles through `packages/core/engines/filter-compiler.ts` — parameterised,
never string-concatenated, and an unknown field key throws rather than
silently widening the result set.

Column set in the file: `Locked · Notes · Country · Latest Email Status ·
Deals · Amount · Untouched Records · Tasks · Current Platform · Lead Name ·
Email · Phone · Lead Status · Gender · Lead Category · Language · Department ·
ARK Account Number · Location`. Seed data via `SavedView`, never code.

Depends on: operator registry ✅, filter compiler ✅ (`packages/core`),
`SavedView` model ✅, filter TREE builder UI ⬜, record engine ⬜ (to filter
anything).

## Screen: Import — a five-stage wizard

25 frames, which are states of five stages. The stage header reads, verbatim
from the file (typo included): `Upload · Actions · Module-File Mapping ·
Fileld Mapping · Assign`.

| Stage | Contents in the file |
|---|---|
| 1 Upload | Drag & drop target ("Drag & Drop the files here"), file list, **Charset** selector |
| 2 Actions | "How should the records in this field be processed" — add new / update only / both |
| 3 Module-File Mapping | Tabs: All Modules · Mapped Modules · UnMapped Modules · Unsupported Files; counts like "Unmapped Files (9)", "1 File" |
| 4 Field Mapping | Tabs: All Columns · Mapped Columns · Unmapped Columns; **Auto Map**; "Columns in Fields" |
| 5 Assign | **Assignment Rules**, "Choose Assignment Rules", "Assign Owner based on Assignment Rules" |

Footer throughout: `Previous · Next · Cancel`.

Depends on: record engine ⬜, `ImportBatch` model ✅, worker import job ⬜,
**assignment engine ⬜ (stage 5 is meaningless without it)**.

⚠️ The gap analysis costed this at 2 days versus ~3 hours for plain CSV
import. It is the single largest screen in the file and the one most coupled
to unbuilt engines. Build it after the record and assignment engines, not
before — a wizard whose last stage cannot assign is a wizard that cannot run.
