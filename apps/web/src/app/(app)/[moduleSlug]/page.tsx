import { notFound } from 'next/navigation';
import { prisma } from '@crm/db';

/**
 * THE module page. One component serves /leads, /deals and every module an
 * Admin invents later — there is deliberately no per-module page anywhere in
 * the app. The counts exist to prove config resolves end-to-end before the
 * record engine slice replaces this empty state with the real list.
 */
export default async function ModulePage({
  params,
}: {
  params: Promise<{ moduleSlug: string }>;
}) {
  const { moduleSlug } = await params;

  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug: moduleSlug, isEnabled: true },
    include: {
      _count: {
        select: {
          // Soft-deleted config stays in the table; it must not inflate counts.
          fields: { where: { isDeleted: false } },
          statuses: { where: { isDeleted: false } },
        },
      },
    },
  });
  if (!mod) notFound();

  return (
    <div className="mx-auto max-w-[1440px] px-8 py-10">
      <h1 className="text-xl font-semibold text-heading">{mod.labelPlural}</h1>

      <section className="mt-6 rounded border border-border bg-surface p-6">
        <p className="text-sm text-body">
          The {mod.labelPlural} list arrives with the record engine slice.
        </p>
        <p className="mt-2 text-xs text-body">
          {mod._count.fields} field{mod._count.fields === 1 ? '' : 's'} ·{' '}
          {mod._count.statuses} status{mod._count.statuses === 1 ? '' : 'es'} configured
        </p>
      </section>
    </div>
  );
}
