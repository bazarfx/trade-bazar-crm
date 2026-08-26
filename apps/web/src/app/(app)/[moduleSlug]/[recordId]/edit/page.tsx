import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { ConfigError } from '@/lib/config/service';
import { storageFor } from '@/lib/records/list';
import { getRecord } from '@/lib/records/service';
import { RecordFormRoute } from '../../_components/record-form-route';
import type { LockedField } from '../../_components/record-form-screen';

/**
 * Edit a record — the same screen as create, in its other mode, and a PAGE
 * for the same measured reason (see `record-form-screen.tsx`).
 *
 * The LOCKED fields are resolved here exactly as the detail screen resolves
 * them: from the STORAGE SHAPE, never from a field name. A table with a
 * Closed By column has permanent conversion credit that no edit may move
 * (spec §7.1), and a table with derived columns has ledger sums that are
 * recomputed rather than typed (spec §8.3). The server strips both from every
 * write regardless; showing them locked is the form telling the truth about
 * it rather than offering a control that silently does nothing.
 */
const CLOSED_BY_REASON =
  'Permanent credit for the converting agent — set once at conversion, never edited.';
const DERIVED_REASON = 'Derived from the deposit ledger — never typed.';

export default async function EditRecordPage({
  params,
}: {
  params: Promise<{ moduleSlug: string; recordId: string }>;
}) {
  const { moduleSlug, recordId } = await params;

  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (!canReadModuleConfig(principal, moduleSlug)) notFound();

  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug: moduleSlug, isEnabled: true },
    select: { id: true, slug: true, label: true, isCore: true },
  });
  if (!mod) notFound();

  const engine = new PermissionEngine(principal.actor, principal.permissions);

  const fieldRows = await prisma.fieldDefinition.findMany({
    where: { moduleId: mod.id, isDeleted: false },
    orderBy: { displayOrder: 'asc' },
    select: { key: true, type: true, systemColumn: true },
  });
  const hidden = engine.hiddenFields(mod.slug);
  const fields = fieldRows.filter((f) => !hidden.has(f.key));

  // The record is read through the scope filter, so a record this actor may
  // not have answers 404 — the same answer an unknown id gets, deliberately.
  try {
    await getRecord(principal, mod.slug, recordId);
  } catch (err) {
    if (err instanceof ConfigError && (err.status === 404 || err.status === 403)) notFound();
    throw err;
  }
  if (!engine.can('edit', mod.slug)) redirect(`/${mod.slug}/${recordId}`);

  const storage = storageFor({ id: mod.id, slug: mod.slug, isCore: mod.isCore }, fields);
  const shape = storage.shape;
  // An account or a ledger row is edited by its own screen, not by this one.
  if (!shape.canInsertRows) redirect(`/${mod.slug}/${recordId}`);

  const locked: LockedField[] = [];
  for (const field of fields) {
    if (field.systemColumn === null) continue;
    if (field.systemColumn === shape.closedByColumn) {
      locked.push({ key: field.key, reason: CLOSED_BY_REASON });
    } else if (shape.derivedColumns.includes(field.systemColumn)) {
      locked.push({ key: field.key, reason: DERIVED_REASON });
    }
  }

  return (
    <RecordFormRoute
      slug={mod.slug}
      label={mod.label}
      systemColumns={Object.fromEntries(fields.map((f) => [f.key, f.systemColumn]))}
      locked={locked}
      recordId={recordId}
    />
  );
}
