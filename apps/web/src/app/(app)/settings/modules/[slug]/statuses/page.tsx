import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { StatusManager } from './_components/status-manager';

/**
 * Status manager for ONE module — but never a specific one: the slug is data,
 * so this single page serves every pipeline the Admin ever creates. The gate
 * here is UX only; the real enforcement is `assertConfigPermission` inside
 * the config service, which no route can forget.
 */
export default async function StatusSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const { actor, permissions } = principal;
  if (!(actor.isAdmin || permissions.specials.has('MANAGE_STATUSES'))) {
    // Someone holding only MANAGE_FIELDS_LAYOUTS can reach this URL from the
    // settings landing; send them back there instead of a dead end.
    redirect('/settings/modules');
  }

  const module = await prisma.moduleDefinition.findFirst({
    where: { slug, isEnabled: true },
    select: { labelPlural: true },
  });
  if (!module) notFound();

  return (
    // The shell's <main> owns the canvas gutter; a second page-level one put
    // every settings screen on a different grid from the module list.
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-medium text-heading">{module.labelPlural} — statuses</h1>
        <p className="mt-1 text-sm text-body">
          Drag to set pipeline order. System behaviour follows the tag, never the name — rename
          freely.
        </p>
      </div>
      <StatusManager slug={slug} />
    </div>
  );
}
