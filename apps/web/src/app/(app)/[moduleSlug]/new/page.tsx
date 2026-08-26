import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { storageFor } from '@/lib/records/list';
import { RecordFormRoute } from '../_components/record-form-route';

/**
 * Create a record — a PAGE, because the file draws it as one.
 * `CRM _ Leads_Create Leads` keeps the sidebar and the top bar on screen, so
 * the form cannot be an overlay over them (see `record-form-screen.tsx`).
 *
 * One route for every module, like every other screen here: the slug is data.
 * The gates are the list screen's, asked one hop earlier — an actor who may
 * not read the module's config gets the same 404 an unknown module gets, and
 * one who may not create is sent back rather than shown a form whose save
 * would 403.
 */
export default async function CreateRecordPage({
  params,
}: {
  params: Promise<{ moduleSlug: string }>;
}) {
  const { moduleSlug } = await params;

  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (!canReadModuleConfig(principal, moduleSlug)) notFound();

  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug: moduleSlug, isEnabled: true },
    select: { id: true, slug: true, label: true, isCore: true },
  });
  if (!mod) notFound();

  const engine = new PermissionEngine(principal.actor, principal.permissions);
  if (!engine.can('create', mod.slug)) redirect(`/${mod.slug}`);

  const fields = await prisma.fieldDefinition.findMany({
    where: { moduleId: mod.id, isDeleted: false },
    orderBy: { displayOrder: 'asc' },
    select: { key: true, type: true, systemColumn: true },
  });
  // Hidden fields never leave the server — the same rule the list and detail
  // screens follow, applied before anything is serialised.
  const hidden = engine.hiddenFields(mod.slug);
  const visible = fields.filter((f) => !hidden.has(f.key));

  // A table the engine refuses to insert into has no create form to draw; its
  // rows are made by their own administration screen or by a pipeline.
  const storage = storageFor({ id: mod.id, slug: mod.slug, isCore: mod.isCore }, visible);
  if (!storage.shape.canInsertRows) redirect(`/${mod.slug}`);

  return (
    <RecordFormRoute
      slug={mod.slug}
      label={mod.label}
      systemColumns={Object.fromEntries(visible.map((f) => [f.key, f.systemColumn]))}
    />
  );
}
