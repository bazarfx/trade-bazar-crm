import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { storageFor } from '@/lib/records/list';
import { PageTitle } from '@/components/shell/page-title';
import { ImportWizard } from '../_components/import/import-wizard';

/**
 * THE import screen — a PAGE at `/[moduleSlug]/import`, not an overlay.
 *
 * CLAUDE.md was rewritten on 22 Aug 2026 to say so outright ("Import is a
 * PAGE, not an overlay"), and the file agrees. Measured on the twenty-four
 * `CRM _ Leads_Import ` frames in `tools/figma/Zoho.fig`, every one of which
 * draws the ORDINARY app chrome behind the wizard:
 *
 *   FRAME             Sidebar - Open  @0,0     256x1024   #ffffff
 *   ROUNDED_RECTANGLE Rectangle 2     @256,0   1184x68    #ffffff   ← top bar
 *   TEXT              "Import Leads"  @286,21  176x26               ← in the bar
 *   FRAME             Profil          @1216,12 208x44               ← in the bar
 *   ROUNDED_RECTANGLE Rectangle 5     @272,84  1152x56    #ffffff   ← toolbar
 *   FRAME             Pop up          @272,152 1152x497   #ffffff   ← the panel
 *
 * An overlay would cover the sidebar and the bar. The file keeps both, which
 * is the whole difference — and it is also why the wizard survives a reload
 * and can be linked to, which a piece of component state could not be.
 *
 * This page is a THIN ADAPTER, exactly like the list page beside it: it
 * resolves the module, asks the permission engine whether this actor may
 * import at all, and hands the wizard four config-derived values. It knows
 * nothing about leads — `/deals/import` and `/whatever-the-admin-invents/
 * import` are this same file.
 */
export default async function ImportPage({
  params,
}: {
  params: Promise<{ moduleSlug: string }>;
}) {
  const { moduleSlug } = await params;

  // The shell layout redirects too, but a page that reads permissions cannot
  // depend on a layout having run — layouts and pages render independently.
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  // Fail closed BEFORE the module is resolved, and 404 rather than 403: to an
  // actor with no access an unknown module and a forbidden one must be
  // indistinguishable. Same gate, same reasoning, as the list page.
  if (!canReadModuleConfig(principal, moduleSlug)) notFound();

  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug: moduleSlug, isEnabled: true },
    select: {
      id: true, slug: true, label: true, labelPlural: true, isCore: true, hasOwner: true,
    },
  });
  if (!mod) notFound();

  const engine = new PermissionEngine(principal.actor, principal.permissions);
  // IMPORT_EXPORT is a special, not a module scope. Without it the route is
  // 404 rather than a disabled screen: the list page already hides the button,
  // so anyone arriving here typed the URL, and a wizard that cannot commit is
  // five stages of wasted work. The commit route asserts this again.
  if (!engine.hasSpecial('IMPORT_EXPORT')) notFound();

  const fieldRows = await prisma.fieldDefinition.findMany({
    where: { moduleId: mod.id, isDeleted: false },
    orderBy: { displayOrder: 'asc' },
    select: { key: true, type: true, systemColumn: true },
  });

  /**
   * Whether these records can be OWNED at all — a storage property, never a
   * slug. The module's own declaration plus whether the table it resolves to
   * physically carries an owner column. Stage 5 asks who ends up owning the
   * imported rows; a module with no owner has nothing to ask, and the wizard
   * skips the question rather than drawing a picker that cannot apply.
   */
  const storageShape = storageFor(
    { id: mod.id, slug: mod.slug, isCore: mod.isCore },
    fieldRows.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
  ).shape;
  const hasOwner = mod.hasOwner && storageShape.ownerColumn !== null;

  return (
    <>
      {/* Drawn by the shell in the top bar at the measured @286,21 — see
          components/shell/page-title.tsx. "Import Leads" is composed from
          `ModuleDefinition.labelPlural`, so it reads "Import Invoices" the day
          an Admin creates that module. */}
      <PageTitle title={`Import ${mod.labelPlural}`} />
      <ImportWizard
        slug={mod.slug}
        labelPlural={mod.labelPlural}
        // `FieldDto` does not serialise the physical column and stage 4 needs
        // it: a required field the ENGINE fills (the owner, the opening
        // status) needs no column in the file, and demanding one would make
        // every import impossible. See _components/import/mapping.ts.
        systemColumns={Object.fromEntries(fieldRows.map((f) => [f.key, f.systemColumn]))}
        hasOwner={hasOwner}
      />
    </>
  );
}
