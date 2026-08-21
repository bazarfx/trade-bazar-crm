/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/settings` — the admin gate, the pointer proof and the
 * ConfigChangeLog entry are asserted there, so this file holds no decision of
 * its own and a future caller cannot route around them.
 */
import { NextResponse } from 'next/server';
import { settingsPatchSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { getSettings, setSettings } from '@/lib/config/settings';

/** The resolved set — every key, with its default where nothing is stored. */
export const GET = guarded(async (_req, principal) => {
  const settings = await getSettings(principal);
  return NextResponse.json({ settings });
});

/**
 * PUT is a PARTIAL write, not a replace: the body carries only the keys that
 * changed. A full-document PUT would let a stale tab revert a pointer somebody
 * else had just moved — and a mis-aimed assignment pointer is silent, since
 * routing keeps working and simply sends everyone's leads to the Admin.
 */
export const PUT = guarded(async (req, principal) => {
  const patch = await parseBody(req, settingsPatchSchema);
  const settings = await setSettings(principal, patch);
  return NextResponse.json({ settings });
});
