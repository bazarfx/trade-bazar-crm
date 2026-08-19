import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { LayoutEditor } from './_components/layout-editor';

/**
 * The layout editor for ONE module — any module. The slug is data; nothing
 * below this page knows or cares whether it is leads, deals or something the
 * Admin invented this morning. This gate is UX only — the real enforcement is
 * `assertConfigPermission` inside the config service, which a route cannot
 * forget.
 */
export default async function ModuleLayoutPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const { actor, permissions } = principal;
  const allowed = actor.isAdmin || permissions.specials.has('MANAGE_FIELDS_LAYOUTS');
  if (!allowed) redirect('/');

  const { slug } = await params;
  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug, isEnabled: true },
    select: { slug: true, labelPlural: true },
  });
  if (!mod) notFound();

  return <LayoutEditor slug={mod.slug} moduleLabel={mod.labelPlural} />;
}
