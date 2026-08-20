/**
 * Inspect a decoded .fig tree.
 *
 * Usage, from the directory holding nodes.json:
 *   node inspect.js tree "<frame name>" [depth]   structure with layout + style
 *   node inspect.js find "<substring>"            locate nodes by name
 *   node inspect.js text "<frame name>"           every string in a frame
 *
 * The decoder emits a flat node list; parentIndex.guid rebuilds the tree and
 * parentIndex.position orders siblings the way Figma does.
 */
const fs = require('fs');
const nodes = JSON.parse(fs.readFileSync('nodes.json'));
const K = (g) => (g ? g.sessionID + ':' + g.localID : null);

const kids = new Map();
for (const n of nodes) {
  const p = K(n.parentIndex && n.parentIndex.guid);
  if (!p) continue;
  if (!kids.has(p)) kids.set(p, []);
  kids.get(p).push(n);
}
for (const list of kids.values()) {
  list.sort((a, b) =>
    String(a.parentIndex.position ?? '').localeCompare(String(b.parentIndex.position ?? '')),
  );
}

const hex = (c) => {
  if (!c) return null;
  const h = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  const base = '#' + h(c.r) + h(c.g) + h(c.b);
  return c.a !== undefined && c.a < 1 ? `${base}@${+c.a.toFixed(2)}` : base;
};

function paint(n) {
  const f = (n.fillPaints || []).find((p) => p.type === 'SOLID' && p.visible !== false);
  return f ? hex(f.color) : null;
}
function stroke(n) {
  const s = (n.strokePaints || []).find((p) => p.type === 'SOLID' && p.visible !== false);
  return s ? `${hex(s.color)} ${n.strokeWeight ?? 1}px` : null;
}
function layout(n) {
  if (!n.stackMode || n.stackMode === 'NONE') return null;
  const dir = n.stackMode === 'VERTICAL' ? 'col' : 'row';
  const gap = n.stackSpacing ?? 0;
  const pt = n.stackVerticalPadding ?? 0, pl = n.stackHorizontalPadding ?? 0;
  const pb = n.stackPaddingBottom ?? pt, pr = n.stackPaddingRight ?? pl;
  const align = n.stackPrimaryAlignItems ? `main:${n.stackPrimaryAlignItems}` : '';
  const cross = n.stackCounterAlignItems ? `cross:${n.stackCounterAlignItems}` : '';
  return `flex-${dir} gap:${gap} pad:${pt}/${pr}/${pb}/${pl} ${align} ${cross}`.trim();
}
function radius(n) {
  const r = n.cornerRadius;
  if (r) return `r:${r}`;
  const c = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius,
             n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius];
  return c.some((v) => v) ? `r:${c.map((v) => v || 0).join(',')}` : null;
}
function typo(n) {
  if (n.type !== 'TEXT') return null;
  const s = n.fontSize ? `${n.fontSize}px` : '';
  const w = n.fontName && n.fontName.style ? n.fontName.style : '';
  const fam = n.fontName && n.fontName.family ? n.fontName.family : '';
  const lh = n.lineHeight && n.lineHeight.value ? `/${Math.round(n.lineHeight.value)}` : '';
  const ls = n.letterSpacing && n.letterSpacing.value ? ` ls:${+n.letterSpacing.value.toFixed(2)}` : '';
  return [fam, w, s + lh, ls].filter(Boolean).join(' ');
}

function describe(n) {
  const bits = [];
  const sz = n.size ? `${Math.round(n.size.x)}x${Math.round(n.size.y)}` : '';
  if (sz) bits.push(sz);
  const l = layout(n); if (l) bits.push(l);
  const p = paint(n); if (p) bits.push('bg:' + p);
  const s = stroke(n); if (s) bits.push('border:' + s);
  const r = radius(n); if (r) bits.push(r);
  const t = typo(n); if (t) bits.push(t);
  if (n.type === 'TEXT' && n.textData && n.textData.characters) {
    bits.push(JSON.stringify(n.textData.characters.slice(0, 60)));
  }
  return bits.join('  ');
}

function walk(node, depth, max, indent = '') {
  console.log(`${indent}${(node.type || '?').padEnd(17)} ${(node.name || '').slice(0, 40).padEnd(42)} ${describe(node)}`);
  if (depth >= max) return;
  for (const c of kids.get(K(node.guid)) || []) walk(c, depth + 1, max, indent + '  ');
}

const [cmd, arg, depthArg] = process.argv.slice(2);
if (cmd === 'find') {
  const q = arg.toLowerCase();
  for (const n of nodes) {
    if ((n.name || '').toLowerCase().includes(q)) {
      const sz = n.size ? ` ${Math.round(n.size.x)}x${Math.round(n.size.y)}` : '';
      console.log(`${(n.type || '').padEnd(17)} ${n.name}${sz}`);
    }
  }
} else if (cmd === 'tree') {
  const root = nodes.find((n) => n.name === arg) || nodes.find((n) => (n.name || '').includes(arg));
  if (!root) { console.error('not found:', arg); process.exit(1); }
  walk(root, 0, Number(depthArg || 4));
} else if (cmd === 'text') {
  const root = nodes.find((n) => n.name === arg) || nodes.find((n) => (n.name || '').includes(arg));
  if (!root) { console.error('not found:', arg); process.exit(1); }
  const out = [];
  (function rec(n) {
    if (n.type === 'TEXT' && n.textData && n.textData.characters) out.push(n.textData.characters);
    for (const c of kids.get(K(n.guid)) || []) rec(c);
  })(root);
  console.log(out.join('\n'));
}
