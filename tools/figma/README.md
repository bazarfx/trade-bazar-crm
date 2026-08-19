# Figma extraction pipeline

The `.fig` file is a zip containing a **Zstandard-compressed Kiwi binary**.
Chromium/browsers can't read it and the Figma MCP needs edit access, so we decode locally.

## Steps

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
