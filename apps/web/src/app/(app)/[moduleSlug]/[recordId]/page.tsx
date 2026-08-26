import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { referenceOptionsFor } from '@/lib/records/reference-options';
import { PermissionEngine } from '@crm/core';
import type { Principal } from '@/lib/auth/actor';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { resolveModuleLayout } from '@/lib/config/layouts';
import { ConfigError } from '@/lib/config/service';
import { coreModuleStorages, storageFor } from '@/lib/records/list';
import { getRecord, getTimeline } from '@/lib/records/service';
import { assertPeopleModule, personWorkload } from '@/lib/records/workload';
import type { PersonWorkload, WorkloadModule } from '@crm/shared';
import { Avatar, StatusChip } from '@/components/ui';
import { demoAvatarFor } from '@/components/demo-avatar';
import { AnalyticsPanel } from './_components/analytics-panel';
import { changeEntries } from './_components/changes';
import { DepositsPanel } from './_components/deposits-panel';
import { DetailActions } from './_components/detail-actions';
import { InfoPanel, type InfoSection, type LockedValue } from './_components/info-panel';
import { OwnedRecordsPanel, type OwnedModuleTable } from './_components/owned-records-panel';
import { QuickActions, type OwnerMode } from './_components/quick-actions';
import { TimelinePanel, type InheritedFrom, type TimelineRow } from './_components/timeline-panel';
import type { DetailField } from './_components/value';
import { WorkloadPanel } from './_components/workload-panel';

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
 * What ELSE a record shows is read from its STORAGE SHAPE, never its slug:
 * a table with a deposit ledger gets the deposits panel, a table with a
 * Closed By column locks that value and hands its owner over instead of
 * reassigning it, a table that inherits its timeline shows its parent's
 * history interleaved, and a module other records link to gets analytics.
 * Deals and Campaigns are the modules that happen to answer today.
 *
 * A server component on purpose: the record, its layout and its timeline are
 * three permission-checked reads, and doing them here means the client is
 * handed what it may see rather than being trusted to ask for it.
 */

/** The first page of the timeline. Older entries load on demand. */
const TIMELINE_PAGE = 50;

/** Why a locked value is locked, in the reader's words. Keyed on the SHAPE
 *  fact that locks it, never on a field name. */
const CLOSED_BY_REASON =
  'Permanent credit for the converting agent — set once at conversion, never edited.';
const DERIVED_REASON = 'Derived from the deposit ledger — never typed.';

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

/**
 * `src` is optional on `AvatarProps`; spread the prop only when there is one
 * rather than passing an explicit `undefined`, so an id-less record falls
 * through to the initials disc instead of being handed a value that is not one.
 */
function avatarSrc(id: string): { src?: string } {
  const src = demoAvatarFor(id);
  return src === undefined ? {} : { src };
}

/** A displayable string, or null. Field values arrive as `unknown`. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** A module's live fields as the detail components need them, minus what
 *  this role may not see. */
async function visibleFields(
  engine: PermissionEngine,
  moduleId: string,
  moduleSlug: string,
): Promise<DetailField[]> {
  const rows = await prisma.fieldDefinition.findMany({
    // Soft-deleted config stays in the table forever (invariant 4) and must
    // never come back as a row on the panel.
    where: { moduleId, isDeleted: false },
    orderBy: { displayOrder: 'asc' },
    select: {
      key: true, label: true, type: true, systemColumn: true,
      // Options come along so a picklist cell can show its LABEL rather
      // than the value it stores. Retired options are included: an older
      // record still points at one and would otherwise lose its label.
      options: { select: { value: true, label: true }, orderBy: { displayOrder: 'asc' } },
    },
  });
  // Hidden fields are dropped HERE, before anything is rendered — the record
  // itself is stripped on serialisation, but the LABELS are config and would
  // otherwise leak the existence of a field this role may not see.
  const refOptions = await referenceOptionsFor(rows);
  const hidden = engine.hiddenFields(moduleSlug);
  return rows
    .filter((f) => !hidden.has(f.key))
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      systemColumn: f.systemColumn,
      options: refOptions.get(f.key) ?? f.options,
    }));
}

/**
 * This person's workload, or null when this record is not a person.
 *
 * THE GATE IS STRUCTURAL, NOT A SLUG. `assertPeopleModule` compares storage
 * DELEGATES: the people table is whatever every `ownerColumn` foreign key
 * points at, so renaming Users to "Staff" changes nothing here and a lead is
 * refused for a reason that survives any amount of Admin renaming. It is the
 * same gate `GET …/workload` applies, one hop earlier.
 *
 * WHY THIS IS READ ON THE SERVER rather than probed from the browser the way
 * `DepositsPanel` and `AnalyticsPanel` probe theirs: the assigned-records
 * table underneath needs each module's OWNER FIELD KEY, which is resolved from
 * `FieldDefinition.systemColumn` — server-side config that no route exposes
 * and that nothing may guess (a deal has two USER_LOOKUP fields, and the wrong
 * one is Closed By). Since the page must read that here anyway, reading the
 * counts here too costs one query set instead of two and puts the numbers in
 * the first paint. The route stays the live contract: the panel's Refresh
 * re-reads it, and a 404 from it still blanks the panel.
 *
 * 404 and 403 both mean "not for you" and both mean "draw nothing" — the same
 * rule `loadRecord` above follows. Anything else is a real fault.
 */
async function loadWorkload(
  principal: Principal,
  slug: string,
  recordId: string,
): Promise<PersonWorkload | null> {
  try {
    await assertPeopleModule(slug);
    return await personWorkload(principal, recordId);
  } catch (err) {
    if (err instanceof ConfigError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/**
 * How many columns the assigned-records table draws.
 *
 * It is a summary on somebody else's page, not the module's list screen: six
 * fields identify a record and fit the panel without a horizontal scroll, and
 * the other thirty are one row click away.
 */
const OWNED_TABLE_COLUMNS = 6;

/**
 * What the assigned-records table needs to draw each module this person owns
 * records in — resolved from CONFIG and STORAGE, never from a module name.
 *
 * Three batched queries for every module at once, not three per module. Each
 * module contributes a tab only if it clears two structural tests:
 *
 *   1. its storage shape declares an `ownerColumn` — otherwise its rows are
 *      not owned by anyone and "assigned to this person" has no meaning;
 *   2. a field this role may SEE maps to that column. A role the matrix hides
 *      the owner field from cannot be handed a filter on it: hiding a field in
 *      the UI is not a security control, and offering the filter anyway would
 *      make the matrix cosmetic. Dropping the module is the fail-closed answer.
 *
 * The owner field is then removed from the columns. Every row in this table
 * has the same owner by construction, so it would be a column of one repeated
 * name where a differing field could have gone.
 */
async function ownedModuleTables(
  engine: PermissionEngine,
  owns: WorkloadModule[],
): Promise<OwnedModuleTable[]> {
  if (owns.length === 0) return [];

  const mods = await prisma.moduleDefinition.findMany({
    where: { slug: { in: owns.map((o) => o.slug) }, isEnabled: true },
    select: { id: true, slug: true, isCore: true, recordTitleField: true },
  });
  if (mods.length === 0) return [];
  const moduleIds = mods.map((m) => m.id);

  const [fieldRows, statusRows] = await Promise.all([
    prisma.fieldDefinition.findMany({
      // Soft-deleted config stays in the table forever (invariant 4) and must
      // never come back as a column.
      where: { moduleId: { in: moduleIds }, isDeleted: false },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        moduleId: true, key: true, label: true, type: true, systemColumn: true,
        options: { select: { value: true, label: true }, orderBy: { displayOrder: 'asc' } },
      },
    }),
    // Deleted statuses INCLUDED: retiring a status does not move the records
    // sitting on it, and a chip that fell back to a raw id would be the one
    // cell on the page nobody can read.
    prisma.status.findMany({
      where: { moduleId: { in: moduleIds } },
      orderBy: { displayOrder: 'asc' },
      select: { moduleId: true, id: true, name: true, tag: true, color: true },
    }),
  ]);

  const tables: OwnedModuleTable[] = [];
  // `owns` arrives in the Admin's own nav order; the tabs keep it.
  for (const entry of owns) {
    const owned = mods.find((m) => m.slug === entry.slug);
    if (!owned) continue;

    // Which physical column carries the owner is a STORAGE fact, asked of the
    // shape exactly as this page asks it for the record it is drawing.
    const ref = { id: owned.id, slug: owned.slug, isCore: owned.isCore };
    const ownerColumn = storageFor(ref, []).shape.ownerColumn;
    if (ownerColumn === null) continue;

    const hidden = engine.hiddenFields(owned.slug);
    const visible = fieldRows.filter((f) => f.moduleId === owned.id && !hidden.has(f.key));
    const ownerField = visible.find((f) => f.systemColumn === ownerColumn);
    if (!ownerField) continue;

    const rest = visible.filter((f) => f.key !== ownerField.key);
    // `recordTitleField` names the field that IS the record's identity — never
    // a hardcoded `name`. It can be hidden from this role, in which case no
    // column claims the avatar and none is pinned.
    const titleField = rest.find((f) => f.key === owned.recordTitleField);
    const ordered = titleField
      ? [titleField, ...rest.filter((f) => f.key !== titleField.key)]
      : rest;

    tables.push({
      slug: entry.slug,
      label: entry.label,
      labelPlural: entry.labelPlural,
      total: entry.total,
      ownerFieldKey: ownerField.key,
      ownerFieldType: ownerField.type,
      titleFieldKey: titleField?.key ?? null,
      columns: ordered.slice(0, OWNED_TABLE_COLUMNS).map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        systemColumn: f.systemColumn,
        options: f.options,
      })),
      statuses: statusRows
        .filter((s) => s.moduleId === owned.id)
        .map((s) => ({ id: s.id, name: s.name, tag: s.tag, color: s.color })),
    });
  }

  return tables;
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
      hasOwner: true,
      hasTimeline: true,
      recordTitleField: true,
    },
  });
  if (!mod) notFound();

  const engine = new PermissionEngine(principal.actor, principal.permissions);

  const [fields, statusRows, layoutSections, linkedFrom] = await Promise.all([
    visibleFields(engine, mod.id, mod.slug),
    prisma.status.findMany({
      where: { moduleId: mod.id, isDeleted: false },
      orderBy: { displayOrder: 'asc' },
      select: { id: true, name: true, tag: true, color: true },
    }),
    // The DETAIL layout, reconciled against the live field list: a field added
    // after the layout was saved still appears, a deleted one never does.
    resolveModuleLayout(principal, mod.slug, 'DETAIL'),
    // Does anything link TO records of this module? If so, every record here
    // is something other records are attributed to, and the analytics panel
    // has a question to answer. A count, not a slug test.
    prisma.fieldDefinition.count({
      where: { relatedModuleId: mod.id, type: 'RECORD_LINK', isDeleted: false },
    }),
  ]);
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));

  const loaded = await loadRecord(principal, mod.slug, recordId);
  if (!loaded) notFound();
  const { record, timeline } = loaded;

  // Which column carries the status and which the owner is a property of the
  // module's STORAGE, not of its slug — asking the resolver is what keeps this
  // page working for a module that lives in the generic table.
  const storage = storageFor({ id: mod.id, slug: mod.slug, isCore: mod.isCore }, fields);
  const shape = storage.shape;
  const statusColumn = shape.statusColumn;
  const statusField = statusColumn ? fields.find((f) => f.systemColumn === statusColumn) : undefined;
  const currentStatusId = statusField ? text(record[statusField.key]) : null;

  // Same question for the owner, asked the same way — of the STORAGE, never of
  // the slug. `fields` has already had the hidden ones stripped, so a role the
  // matrix hides the owner field from finds nothing here and gets no owner
  // control; hiding a field in the UI is not a security control, and printing
  // the owner beside a hidden field would make the matrix cosmetic.
  const ownerColumn = mod.hasOwner ? shape.ownerColumn : null;
  const ownerField = ownerColumn ? fields.find((f) => f.systemColumn === ownerColumn) : undefined;
  const currentOwnerId = ownerField ? text(record[ownerField.key]) : null;

  // ── what the storage shape says this record IS ─────────────────────────
  // A Closed By column means the record is the product of a conversion: that
  // value is permanent credit (spec §7.1) and the owner is HANDED OVER, not
  // reassigned. Derived columns are ledger sums (spec §8.3). Both are locked
  // on screen and in the edit form; the server strips them from every write
  // regardless — this is the UI telling the truth about it.
  const locked: LockedValue[] = [];
  for (const field of fields) {
    if (field.systemColumn === null) continue;
    if (field.systemColumn === shape.closedByColumn) locked.push({ key: field.key, reason: CLOSED_BY_REASON });
    else if (shape.derivedColumns.includes(field.systemColumn)) locked.push({ key: field.key, reason: DERIVED_REASON });
  }
  const ownerMode: OwnerMode = shape.closedByColumn !== null ? 'transfer' : 'reassign';
  const hasLedger = shape.ledger !== null;

  // ── the parent whose history this record inherits (spec §8) ────────────
  // Resolved through the storage shapes — "which module writes `Lead` rows"
  // is a question only the table layer answers — and read only when this
  // actor may read that module's config, so a parent's field labels never
  // leak past its own matrix. The entries themselves still render: that
  // something happened, by whom and when, is this record's own history.
  let inheritedFrom: InheritedFrom | null = null;
  let parentUserKeys = new Set<string>();
  if (shape.inheritsTimelineFrom !== null && mod.hasTimeline) {
    const wanted = shape.inheritsTimelineFrom.entityType;
    const parent = (await coreModuleStorages()).find((m) => m.shape.entityType === wanted);
    if (parent && canReadModuleConfig(principal, parent.ref.slug)) {
      const [parentModule, parentFields, parentStatuses] = await Promise.all([
        prisma.moduleDefinition.findUnique({ where: { id: parent.ref.id }, select: { label: true } }),
        visibleFields(engine, parent.ref.id, parent.ref.slug),
        prisma.status.findMany({
          where: { moduleId: parent.ref.id },
          orderBy: { displayOrder: 'asc' },
          select: { id: true, name: true, tag: true, color: true },
        }),
      ]);
      inheritedFrom = {
        label: parentModule?.label ?? parent.ref.slug,
        fields: parentFields,
        statuses: parentStatuses,
      };
      parentUserKeys = new Set(parentFields.filter((f) => f.type === 'USER_LOOKUP').map((f) => f.key));
    }
  }

  // Every user id this record or its history mentions, resolved to a name in
  // ONE query. A timeline that says `9f3c…` instead of "Priya Nair" is not a
  // timeline anyone can act on. Only id and fullName are read: this is a
  // display lookup, not a read of the users module. Inherited rows carry the
  // PARENT's keys, so both key sets are consulted.
  const userKeys = new Set(fields.filter((f) => f.type === 'USER_LOOKUP').map((f) => f.key));
  const userIds = new Set<string>();
  for (const key of userKeys) {
    const id = text(record[key]);
    if (id) userIds.add(id);
  }
  for (const entry of timeline.entries) {
    const keys = entry.inherited ? parentUserKeys : userKeys;
    for (const [key, pair] of changeEntries(entry.changes)) {
      if (!keys.has(key)) continue;
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

  // ── what this record shows because it is a PERSON ──────────────────────
  // Same principle as the ledger, the analytics and the inherited timeline
  // above: the page asks the STORAGE what this record is, and draws what the
  // answer implies. Null here means "the owner foreign keys do not point at
  // this table", which is the only definition of a person the engine has.
  const workload = await loadWorkload(principal, mod.slug, record.id);
  const ownedTables = workload === null ? [] : await ownedModuleTables(engine, workload.owns);

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
          {/**
           * The record's picture, at the LARGER of the two sizes the file
           * draws (44, the top-bar `Avatar`; the other is the 24 in a table
           * row). The .fig contains no record-detail frame at all — measured:
           * its only CRM screens are `CRM _ Leads`, its filter/sort/saved-
           * filter states and `CRM _ Leads_Import` — so per CLAUDE.md's "Not
           * in the Figma" rule this composes from the drawn primitives rather
           * than inventing a third size. 44 is the size the file uses when an
           * avatar identifies a whole page's subject.
           *
           * The image is DEMO imagery derived from the record id; the reason
           * it is a function rather than stored data is in
           * components/demo-avatar.ts. `name` falls back to initials when the
           * id is blank, and is announced by the `h1` beside it either way.
           */}
          <Avatar size={44} name={title} {...avatarSrc(record.id)} />
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

        {/* Edit only. There is no Convert action on this page or any other:
            conversion is webhook-driven (spec §7). */}
        <DetailActions
          slug={mod.slug}
          label={mod.label}
          recordId={record.id}
          canEdit={canEdit}
          // A user account gets the account form and a Reset password action.
          // The same structural test as the Profile tabs: the storage shape,
          // never the slug.
          account={
            storage.delegateName === 'user'
              ? {
                  canManage:
                    principal.actor.isAdmin ||
                    principal.permissions.specials.has('MANAGE_USERS_ROLES'),
                  name: title,
                }
              : null
          }
        />
      </div>

      {/* The person view: what they are carrying, then which records those
          are. Full width and directly under the header because the client's
          ask was that "everything must be visible at once" — no tabs, no
          drill-down. Both render only when this record is a person; on every
          other module `workload` is null and neither exists. */}
      {workload !== null ? (
        <WorkloadPanel slug={mod.slug} recordId={record.id} initial={workload} />
      ) : null}
      {ownedTables.length > 0 ? (
        <OwnedRecordsPanel slug={mod.slug} personId={record.id} modules={ownedTables} />
      ) : null}

      {/* Three columns, each scrolling its own content so the page itself never
          grows: a 40-field record must not push the timeline below the fold,
          and a two-year timeline must not push the quick actions off screen.
          Expressed against the viewport like the list screen's panels.

          EXCEPT on a person, where the page above these columns already
          scrolls: pinning them to the viewport there would leave a full screen
          of whitespace under the assigned-records table before the timeline
          began. The timeline stays exactly where it is — on a person it is
          their audit trail, which belongs beside their numbers. */}
      {/* The class is joined inline rather than with `cn`: every export of a
          `'use client'` module is a client reference, so this SERVER component
          calling that helper throws at render — the warning `cn`'s own
          definition carries. Two branches need no helper anyway. */}
      <div
        className={`flex items-stretch gap-6 ${
          workload !== null ? 'h-[42rem]' : 'h-[calc(100vh-9.5rem)]'
        }`}
      >
        <InfoPanel
          title={`${mod.label} information`}
          sections={sections}
          record={record}
          statuses={statusRows}
          userNames={userNames}
          locked={locked}
          className="w-80 shrink-0"
        />

        {/* The centre column: the ledger and the analytics, when the storage
            says this record has them, above the timeline. min-w-0: without it
            this flex child refuses to shrink below its content's intrinsic
            width and the whole page scrolls sideways. */}
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {hasLedger ? (
            <DepositsPanel slug={mod.slug} recordId={record.id} className="max-h-[45%] shrink-0" />
          ) : null}
          {linkedFrom > 0 ? <AnalyticsPanel slug={mod.slug} recordId={record.id} /> : null}
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
            ownLabel={mod.label}
            inheritedFrom={inheritedFrom}
            className="min-h-0 flex-1"
          />
        </div>

        <QuickActions
          slug={mod.slug}
          recordId={record.id}
          statusFieldKey={statusField?.key ?? null}
          statusFieldLabel={statusField?.label ?? 'Status'}
          statuses={statusRows}
          currentStatusId={currentStatusId}
          canEdit={canEdit}
          // The Admin's own label, never a hardcoded "Owner": the field is
          // called "Lead Owner" on Leads and whatever they rename it to next.
          ownerFieldLabel={ownerField?.label ?? null}
          currentOwnerId={currentOwnerId}
          // Resolved in the same batched lookup the timeline uses, so the
          // control opens on a NAME rather than flashing a UUID first.
          currentOwnerName={
            currentOwnerId === null
              ? null
              : (users.find((u) => u.id === currentOwnerId)?.fullName ?? null)
          }
          ownerMode={ownerMode}
          className="w-80 shrink-0"
        />
      </div>
    </div>
  );
}
