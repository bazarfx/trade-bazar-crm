# Figma extraction pipeline

The `.fig` file is a zip containing a **Zstandard-compressed Kiwi binary**.
Chromium/browsers can't read it and the Figma MCP needs edit access, so we decode locally.

## Steps

0. The source file is committed at `tools/figma/Zoho.fig` (20 MB). Decoded
   output goes to `tools/figma/out/`, which is gitignored — `nodes.json` is
   154 MB and is regenerated, never committed.

```bash
mkdir -p out && cd out
unzip -q ../Zoho.fig -d extracted/ && cd extracted
node ../../decode.js          # → nodes.json (64,929 nodes)
node ../../extract-tokens.js  # → tokens.css, copy over apps/web/src/app/tokens.css
node ../../inspect.js tree "CRM _ Leads" 3
```

Requires `zstd` (brew) and `kiwi-schema` (a repo devDependency).

1. `unzip Zoho.fig -d extracted/` → `canvas.fig`, `images/`, `meta.json`
2. `canvas.fig` layout: `"fig-kiwi"` + uint32 version, then length-prefixed chunks.
   - chunk 0 — raw-deflate, the Kiwi **schema**
   - chunk 1 — **zstd**, the message data (older files use deflate here)
3. Decode the schema with `kiwi-schema`, then walk the message with a tolerant
   decoder (the bundled `decodeMessage` throws on `ClientRenderedMetadata`).
4. `nodeChanges` is the full node tree — 64,929 nodes across 11 pages.

## Scripts

| Script | Does |
|---|---|
| `decode.js` | `.fig` → `nodes.json` |
| `extract-tokens.js` | variables → `tokens.css` (49 tokens, aliases resolved) |
| `texts2.js <nodeId>` | dump all text in a frame, for reading screens |

## Auto-layout → flexbox

| Figma | CSS |
|---|---|
| `stackMode` VERTICAL/HORIZONTAL | `flex-direction` |
| `stackSpacing` | `gap` |
| `stackHorizontal/VerticalPadding` | `padding` |
| `stackPrimary/CounterAlignItems` | `justify-content` / `align-items` |
| `stackPrimary/CounterSizing` | `flex-grow` / `width: fit-content` |
| `fillPaints[].colorVar` | resolves to a **token name**, not a hex |

## Do not hand-transcribe values

If a colour or spacing number is typed by hand into a component, it will drift.
Everything comes from `tokens.css`, which is generated.

## Reading the design

`inspect.js` is the tool to reach for — it prints structure with auto-layout,
fills, radii and type, so a screen can be measured instead of eyeballed:

| Command | Does |
|---|---|
| `node inspect.js tree "<frame>" [depth]` | structure + layout + colours + type |
| `node inspect.js find "<substring>"` | locate nodes by name |
| `node inspect.js text "<frame>"` | every string in a frame |

What was measured out of it lives in `docs/DESIGN-SPEC.md`, with the usage
counts behind each decision. Trust that file over memory, and re-measure
rather than assuming when the design changes.
