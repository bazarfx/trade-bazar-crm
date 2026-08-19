import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { FieldBuilder } from './_components/field-builder';

/**
 * The field builder (spec §4.4) — ONE page for every module, resolved by
 * slug. There is deliberately no per-module builder anywhere; a module the
 * Admin invents next year gets this screen without a deploy.
 *
 * The gate here is UX only — the real enforcement is `assertConfigPermission`
 * inside the config service, which a route cannot forget.
 */
export default async function FieldBuilderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const { actor, permissions } = principal;
  if (!actor.isAdmin && !permissions.specials.has('MANAGE_FIELDS_LAYOUTS')) redirect('/');

  const module = await prisma.moduleDefinition.findFirst({
    where: { slug, isEnabled: true },
    select: { slug: true, labelPlural: true },
  });
  if (!module) notFound();

  return (
    <div className="mx-auto max-w-[1440px] px-8 py-10">
      <Link
        href="/settings/modules"
        data-track={`${module.slug}.fields.back.open`}
        className="text-sm text-primary hover:underline"
      >
        ← Module settings
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-heading">{module.labelPlural} — fields</h1>
      <p className="mt-1 text-sm text-body">
        Add fields from the palette, drag rows to reorder, click a row to edit.
      </p>

      <FieldBuilder slug={module.slug} label={module.labelPlural} />
    </div>
  );
}
