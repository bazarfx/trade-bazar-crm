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

### Sidebar — 256 wide, full height
`bg #ffffff`, `flex-col`, `gap 24`, `padding 24`, radius 12 when floating.
Inner content width 208.

- Collapse button 28×28, radius 8, 6px padding, bordered `#f6f6f6`
- Profile row 208×44: avatar 44 (circle) + column(role overline 10px `#757575`,
  name 14px Medium `#000000`), gap 12
- Divider 208×2, `#f6f6f6`, radius 2
- Nav groups separated by dividers. Group order and labels:
  1. **Main** — CRM, Contacts, Calls, Deals, Leads, Dashboard
  2. **Settings** — Settings, Help
  3. Logout Account
- Nav link 208×40, `flex-row`, `gap 12`, `padding 10/12`, radius 8.
  Icon 20, label 14px Medium, `letter-spacing -2`.
  Resting label `#757575`; current item label `#000000` with `bg #f6f6f6`.
- Group heading ("Main") is a 10px Medium overline, `#757575`, padding 0/12.

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

Three states of the same list screen, not separate pages:

- **Filter rail** (left, 230): the three groups already built — System Defined
  Filters, Filter By fields, Filter By Related Modules.
- **Filter / Sort** toolbar buttons open their panels over the list.
- The saved-filter state shows the view selector ("All Leads") driving the
  column set and filter tree.
- Table chrome, pagination and the `Show N Rows` selector are identical across
  all three — only the panel above the table changes.

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
