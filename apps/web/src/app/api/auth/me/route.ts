import { NextResponse } from 'next/server';
import { getPrincipal } from '@/lib/auth/session';
import { SPECIAL_PERMISSIONS, type SpecialPermission } from '@crm/shared';

/** The signed-in user, their role and what the UI is allowed to render. */
export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { user, actor, permissions } = principal;

  return NextResponse.json({
    user,
    isAdmin: actor.isAdmin,
    groupIds: actor.groupIds,
    modules: [...permissions.modules.values()].map((m) => ({
      slug: m.moduleSlug,
      viewScope: m.viewScope,
      canCreate: m.canCreate,
      canEdit: m.canEdit,
      canDelete: m.canDelete,
    })),
    specials: SPECIAL_PERMISSIONS.filter(
      (p: SpecialPermission) => actor.isAdmin || permissions.specials.has(p),
    ),
  });
}
