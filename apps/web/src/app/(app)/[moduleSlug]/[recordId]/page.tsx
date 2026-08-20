import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import type { Principal } from '@/lib/auth/actor';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { resolveModuleLayout } from '@/lib/config/layouts';
import { ConfigError } from '@/lib/config/service';
import { storageFor } from '@/lib/records/list';
import { getRecord, getTimeline } from '@/lib/records/service';
import { StatusChip } from '@/components/ui';
import { changeEntries } from './_components/changes';
import { DetailActions } from './_components/detail-actions';
import { InfoPanel, type InfoSection } from './_components/info-panel';
import { QuickActions } from './_components/quick-actions';
import { TimelinePanel, type TimelineRow } from './_components/timeline-panel';
import type { DetailField } from './_components/value';

/**
 * THE record detail screen. One page serves /leads/<id>, /deals/<id> and every
 * record of every module an Admin invents later — the slug is data, so there
 * is deliberately no per-module detail page anywhere in this app.
 *
 * Spec §6.5 fixes the shape: information panel LEFT, timeline CENTRE, notes
 * and quick actions RIGHT. Everything in those three columns is read from
 * config at request time — the sections and their order from the DETAIL
 * layout, the labels from `FieldDefinition`, the chip from `Status`, the
 * timeline from `AuditLog`.
 *
 * A server component on purpose: the record, its layout and its timeline are
 * three permission-checked reads, and doing them here means the client is
 * handed what it may see rather than being trusted to ask for it.
 */

/** The first page of the timeline. Older entries load on demand. */
const TIMELINE_PAGE = 50;

/**
 * The record and its first page of timeline, or null when this actor may not
 * have it.
 *
 * `getRecord` answers 404 for a record that does not exist AND for one outside
 * the actor's scope, deliberately — a 403 on a record you may not see confirms
 * that it exists. This page keeps that property by turning both into the same
 * `notFound()`. Anything that is not an access answer is a real fault and
 * propagates to the error boundary rather than being disguised as a 404.
 */
async function loadRecord(principal: Principal, slug: string, recordId: string) {
  try {
    const record = await getRecord(principal, slug, recordId);
    // Sequential, not Promise.all: the second call re-checks the same scope,
    // and a rejected promise nobody is awaiting yet is an unhandled rejection.
    const timeline = await getTimeline(principal, slug, recordId, { take: TIMELINE_PAGE });
    return { record, timeline };
  } catch (err) {
    if (err instanceof ConfigError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/** A displayable string, or null. Field values arrive as `unknown`. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{ moduleSlug: string; recordId: string }>;
}) {
  const { moduleSlug, recordId } = await params;

  // The shell layout redirects too, but a page that reads permissions cannot
  // depend on a layout having run — layouts and pages render independently.
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  // Fail closed BEFORE the module is resolved, exactly as the list page does:
  // configuration describes the data, so field labels, section names and
  // status names are inside the permission boundary too. notFound() rather
  // than a 403 keeps an unknown module and a forbidden one indistinguishable.
  if (!canReadModuleConfig(principal, moduleSlug)) notFound();

  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug: moduleSlug, isEnabled: true },
    select: {
      id: true,
      slug: true,
      label: true,
      labelPlural: true,
      isCore: true,
      hasTimeline: true,
      recordTitleField: true,
    },
  });
  if (!mod) notFound();

  const engine = new PermissionEngine(principal.actor, principal.permissions);

  const [fieldRows, statusRows, layoutSections] = await Promise.all([
    // Soft-deleted config stays in the table forever (invariant 4) and must
    // never come back as a row on the panel.
    prisma.fieldDefinition.findMany({
      where: { moduleId: mod.id, isDeleted: false },
      orderBy: { displayOrder: 'asc' },
      select: {
        key: true, label: true, type: true, systemColumn: true,
        // Options come along so a picklist cell can show its LABEL rather
        // than the value it stores. Retired options are included: an older
        // record still points at one and would otherwise lose its label.
        options: { select: { value: true, label: true }, orderBy: { displayOrder: 'asc' } },
      },
    }),
    prisma.status.findMany({
      where: { moduleId: mod.id, isDeleted: false },
      orderBy: { displayOrder: 'asc' },
      select: { id: true, name: true, tag: true, color: true },
    }),
    // The DETAIL layout, reconciled against the live field list: a field added
    // after the layout was saved still appears, a deleted one never does.
    resolveModuleLayout(principal, mod.slug, 'DETAIL'),
  ]);

  // Hidden fields are dropped HERE, before anything is rendered — the record
  // itself is stripped on serialisation, but the LABELS are config and would
  // otherwise leak the existence of a field this role may not see.
  const hidden = engine.hiddenFields(mod.slug);
  const fields: DetailField[] = fieldRows
    .filter((f) => !hidden.has(f.key))
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      systemColumn: f.systemColumn,
      options: f.options,
    }));
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));

  const loaded = await loadRecord(principal, mod.slug, recordId);
  if (!loaded) notFound();
  const { record, timeline } = loaded;

  // Which column carries the status and which the owner is a property of the
  // module's STORAGE, not of its slug — asking the resolver is what keeps this
  // page working for a module that lives in the generic table.
  const storage = storageFor({ id: mod.id, slug: mod.slug, isCore: mod.isCore }, fields);
  const statusColumn = storage.shape.statusColumn;
  const statusField = statusColumn ? fields.find((f) => f.systemColumn === statusColumn) : undefined;
  const currentStatusId = statusField ? text(record[statusField.key]) : null;

  // Every user id this record or its history mentions, resolved to a name in
  // ONE query. A timeline that says `9f3c…` instead of "Priya Nair" is not a
  // timeline anyone can act on. Only id and fullName are read: this is a
  // display lookup, not a read of the users module.
  const userKeys = new Set(fields.filter((f) => f.type === 'USER_LOOKUP').map((f) => f.key));
  const userIds = new Set<string>();
  for (const key of userKeys) {
    const id = text(record[key]);
    if (id) userIds.add(id);
  }
  for (const entry of timeline.entries) {
    for (const [key, pair] of changeEntries(entry.changes)) {
      if (!userKeys.has(key)) continue;
      const from = text(pair.from);
      const to = text(pair.to);
      if (from) userIds.add(from);
      if (to) userIds.add(to);
    }
  }
  const users =
    userIds.size > 0
      ? await prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, fullName: true },
        })
      : [];
  const userNames: [string, string][] = users.map((u) => [u.id, u.fullName]);

  const sections: InfoSection[] = layoutSections
    .map((section) => ({
      id: section.sectionId,
      label: section.label,
      fields: section.fields
        .map((f) => fieldByKey.get(f.key))
        .filter((f): f is DetailField => f !== undefined),
    }))
    // A section whose every field is hidden from this role is not an empty
    // heading — it is a heading that should not be on screen at all.
    .filter((section) => section.fields.length > 0);

  const currentStatus = currentStatusId
    ? (statusRows.find((s) => s.id === currentStatusId) ?? null)
    : null;

  // `recordTitleField` names the field that IS the record's title — never a
  // hardcoded `name` or `fullName`. It can be hidden from this role, or empty.
  const title = text(record[mod.recordTitleField]) ?? `Untitled ${mod.label}`;

  // The record was loaded through the scope filter, so this actor is already
  // in scope for it; the flag is all that is left to check. The server checks
  // both again on every write — this only decides whether to draw the control.
  const canEdit = engine.can('edit', mod.slug);

  const timelineEntries: TimelineRow[] = timeline.entries;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={`/${mod.slug}`}
            data-track={`${mod.slug}.detail.back.click`}
            className="shrink-0 text-sm text-body hover:text-heading"
          >
            ← {mod.labelPlural}
          </Link>
          {/* Truncate, never wrap: a record title is customer data of unbounded
              length and a two-line title moves every panel below it. */}
          <h1 className="min-w-0 truncate text-title font-medium text-heading" title={title}>
            {title}
          </h1>
          {currentStatus ? (
            <StatusChip
              name={currentStatus.name}
              tag={currentStatus.tag}
              color={currentStatus.color}
            />
          ) : null}
        </div>

        <DetailActions
          slug={mod.slug}
          label={mod.label}
          recordId={record.id}
          canEdit={canEdit}
          systemColumns={Object.fromEntries(fields.map((f) => [f.key, f.systemColumn]))}
        />
      </div>

      {/* Three columns, each scrolling its own content so the page itself never
          grows: a 40-field record must not push the timeline below the fold,
          and a two-year timeline must not push the quick actions off screen.
          Expressed against the viewport like the list screen's panels. */}
      <div className="flex h-[calc(100vh-9.5rem)] items-stretch gap-6">
        <InfoPanel
          title={`${mod.label} information`}
          sections={sections}
          record={record}
          statuses={statusRows}
          userNames={userNames}
          className="w-80 shrink-0"
        />

        {/* min-w-0: without it this flex child refuses to shrink below its
            content's intrinsic width and the whole page scrolls sideways. */}
        <TimelinePanel
          slug={mod.slug}
          recordId={record.id}
          entries={timelineEntries}
          nextCursor={timeline.nextCursor}
          fields={fields}
          statuses={statusRows}
          userNames={userNames}
          nowIso={new Date().toISOString()}
          hasTimeline={mod.hasTimeline}
          className="min-w-0 flex-1"
        />

        <QuickActions
          slug={mod.slug}
          recordId={record.id}
          statusFieldKey={statusField?.key ?? null}
          statusFieldLabel={statusField?.label ?? 'Status'}
          statuses={statusRows}
          currentStatusId={currentStatusId}
          canEdit={canEdit}
          className="w-80 shrink-0"
        />
      </div>
    </div>
  );
}
