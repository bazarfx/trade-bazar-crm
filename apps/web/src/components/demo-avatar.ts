/**
 * DEMO imagery — the faces the Figma file draws, standing in for a real
 * profile picture until the upload path exists.
 *
 * WHY THIS FILE EXISTS AND WHAT IT IS NOT.
 *
 * The `CRM _ Leads` frame draws a photograph in exactly two places, and both
 * are IMAGE fills with no data behind them:
 *
 *   ROUNDED_RECTANGLE "Avatar"          44x44  r:36.22  fills:[IMAGE/FILL]
 *                     — Profil @1216,12 in the top bar
 *   FRAME             "Display Picture" 24x24  r:24     fills:[IMAGE/FILL]
 *                     — inside `Table / Base /  List` 200x45, column 0 ONLY
 *                       (measured: every other column's instance is
 *                       `visible: false`)
 *
 * Neither `User` nor `Lead` carries a photo today. `User.profilePhoto` is a
 * seeded IMAGE field, but an IMAGE field stores an `AttachmentRef` and
 * resolves bytes through the `Attachment` table (CLAUDE.md, "Files: store ids,
 * never URLs") — the model exists, the upload route does not. So there is
 * nothing real to render and two dishonest ways to fake it:
 *
 *   - a random face per render, which changes on every paint and makes the
 *     same person look like two people between the list and the detail screen;
 *   - a face stored on the record, which would be inventing customer data.
 *
 * This is the third way: a PURE FUNCTION of the record id. The same record
 * always shows the same face, the value is never written anywhere, and the
 * whole thing disappears the day a real IMAGE field is wired — every caller
 * points `avatarKey` at that field's key instead and this module is deleted.
 *
 * DELIBERATELY NOT A REACT COMPONENT and deliberately not marked `use client`:
 * a plain function so the SERVER-rendered record detail header and the CLIENT
 * table can both call it and agree, which is also what keeps it out of a
 * hydration mismatch — see `hashOf` below.
 */

/**
 * `apps/web/public/figma/avatars/avatar-01..11.png`, extracted from the .fig.
 * 01 is the 200x200 top-bar Avatar and 02 the 300x300 row Display Picture;
 * the rest are the other faces the file's table rows use. All eleven are one
 * pool because a face is a face — nothing here needs to know which node an
 * image came from.
 */
const DEMO_AVATAR_COUNT = 11;

/**
 * The key the demo src is parked under on a table row.
 *
 * `DataTableColumn.avatarKey` names a key ON THE ROW, and the record engine
 * projects rows straight out of `FieldDefinition` — so there is no real key to
 * point at. The double underscore is what keeps this from ever colliding with
 * an Admin-created field key: `FieldDefinition.key` is authored through the
 * field builder and no key it produces starts with one.
 *
 * Exported so the page that SETS `avatarKey` and the table that FILLS it read
 * the same constant. Two spellings of it in two files is exactly how the
 * avatar column silently goes blank.
 */
export const DEMO_AVATAR_ROW_KEY = '__demoAvatar';

/**
 * FNV-1a, 32-bit. Chosen for one property: it is arithmetic only, so it gives
 * byte-identical answers in Node and in the browser. A `Math.random()` pick,
 * or anything reading the clock, would put a different face in the server HTML
 * than in the first client render and React would report a hydration mismatch
 * on every row of the busiest screen in the product.
 *
 * `>>> 0` after each step keeps the value an unsigned 32-bit integer; the
 * multiply is the standard FNV prime written as shifts because `* 16777619`
 * overflows a double's exact-integer range.
 */
function hashOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

/**
 * The demo face for a record or user id — always the same one for the same id.
 *
 * Returns undefined for a blank id so the caller falls through to `Avatar`'s
 * initials disc rather than showing face #1 to everything unidentified. That
 * happens for a system principal, whose `user.id` is deliberately the empty
 * string (see `systemPrincipal` in `@crm/records`).
 */
export function demoAvatarFor(id: string): string | undefined {
  if (id === '') return undefined;
  // +1 because the files are 1-indexed and zero-padded to two digits.
  const n = (hashOf(id) % DEMO_AVATAR_COUNT) + 1;
  return `/figma/avatars/avatar-${String(n).padStart(2, '0')}.png`;
}
