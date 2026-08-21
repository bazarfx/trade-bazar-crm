'use client';

import { useEffect, useState } from 'react';
import type { SpecialPermission } from '@crm/shared';
import { api } from '@/lib/client-api';

/**
 * The signed-in actor's special permissions, for deciding which doors to DRAW.
 *
 * This is UX only and can never be anything else: every write behind these
 * doors is asserted again server-side (`assertMayReassign` and the
 * BULK_OPERATIONS check in the record service), and the scope filter runs in
 * the repository whatever the client believed. A tampered client gets a 403,
 * not a reassignment.
 *
 * `/api/auth/me` already reports the resolved set — including the Admin case,
 * where every special is reported whether or not a row grants it — so nothing
 * here re-derives a permission from a role name.
 */

/** Shared so the initial render is not a new Set every time. */
const NONE: ReadonlySet<SpecialPermission> = new Set<SpecialPermission>();

interface MeResponse {
  specials: SpecialPermission[];
}

export function useSpecials(): ReadonlySet<SpecialPermission> {
  const [specials, setSpecials] = useState<ReadonlySet<SpecialPermission>>(NONE);

  useEffect(() => {
    let cancelled = false;
    api<MeResponse>('/api/auth/me')
      .then((me) => {
        if (!cancelled) setSpecials(new Set(me.specials));
      })
      .catch(() => {
        // Fail closed and stay silent. The only outcome of a failure here is
        // that an action is not offered; an error banner about a permission
        // read the user did not ask for would be noise on every list screen.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return specials;
}
