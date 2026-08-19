/**
 * Field definition operations — module-agnostic by construction. The module
 * arrives as a slug, resolves to a ModuleDefinition row, and nothing below
 * that point knows or cares which module it is shaping.
 *
 * Every mutation funnels through `applyConfigChange`, so the permission
 * assertion, the before/after snapshot and the ConfigChangeLog row are
 * structural — no code in this file could forget them.
 *
 * Two invariants drive most decisions here:
 *  - keys are IMMUTABLE and reserved forever: soft-deleted fields keep their
 *    key (the @@unique([moduleId, key]) index spans deleted rows), which is
 *    what makes restore collision-free by construction;
 *  - nothing is hard-deleted: records and audit diffs still hold field keys
 *    and option values, so the rows behind them must survive retirement.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import {
  collectFieldKeys,
  uniqueFieldKey,
  FIELD_CAP_HARD,
  FIELD_CAP_SOFT,
  FIELD_TYPE_SPECS,
  type DependencyReport,
  type FieldCreateInput,
  type FieldType,
  type FieldUpdateInput,
  type FilterNode,
  type ReorderInput,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { assertModuleReadAccess } from '@/lib/config/access';
import {
  applyConfigChange,
  assertConfigPermission,
  ConfigError,
  requireModule,
  type Tx,
} from '@/lib/config/service';

// ── outbound shapes ───────────────────────────────────────────────────────

export interface FieldOptionDto {
  id: string;
  label: string;
  value: string;
  color: string | null;
  displayOrder: number;
  isDeleted: boolean;
}

export interface FieldDto {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  helpText: string | null;
  isRequired: boolean;
  isUnique: boolean;
  isSystem: boolean;
  isIndexed: boolean;
  isDeleted: boolean;
  sectionId: string | null;
  displayOrder: number;
  validation: unknown;
  defaultValue: unknown;
  options: FieldOptionDto[];
}

type FieldWithOptions = Prisma.FieldDefinitionGetPayload<{ include: { options: true } }>;

/** Options always travel WITH their isDeleted flag: a record detail page must
 *  be able to label a historical value whose option was retired, while the
 *  form picker filters the flag client-side. */
function toDto(field: FieldWithOptions): FieldDto {
  return {
    id: field.id,
    key: field.key,
    label: field.label,
    type: field.type,
    helpText: field.helpText,
    isRequired: field.isRequired,
    isUnique: field.isUnique,
    isSystem: field.isSystem,
    isIndexed: field.isIndexed,
    isDeleted: field.isDeleted,
    sectionId: field.sectionId,
    displayOrder: field.displayOrder,
    validation: field.validation,
    defaultValue: field.defaultValue,
    options: [...field.options]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((o) => ({
        id: o.id,
        label: o.label,
        value: o.value,
        color: o.color,
        displayOrder: o.displayOrder,
        isDeleted: o.isDeleted,
      })),
  };
}

const WITH_OPTIONS = { options: true } as const;

/** Nullable Json column writes: undefined leaves the column untouched,
 *  null clears it, anything else replaces it. */
function jsonWrite(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

/** A sectionId travels as user input; a bogus one must be a 422, not a raw
 *  foreign-key error surfacing as a 500. */
async function assertSection(sectionId: string | null | undefined, moduleId: string): Promise<void> {
  if (!sectionId) return;
  const section = await prisma.formSection.findFirst({
    where: { id: sectionId, moduleId, isDeleted: false },
    select: { id: true },
  });
  if (!section) throw new ConfigError('Section not found in this module', 422, 'VALIDATION');
}

/** Load a field scoped to its module or 404 — a fieldId from another module
 *  must be indistinguishable from a missing one. */
async function requireField(moduleId: string, fieldId: string): Promise<FieldWithOptions> {
  const field = await prisma.fieldDefinition.findFirst({
    where: { id: fieldId, moduleId },
    include: WITH_OPTIONS,
  });
  if (!field) throw new ConfigError('Field not found', 404, 'NOT_FOUND');
  return field;
}

// ── list ──────────────────────────────────────────────────────────────────

export async function listFields(
  principal: Principal,
  moduleSlug: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<FieldDto[]> {
  // Configuration describes the data, so it fails closed the same way: a role
  // with no view of this module's records may not enumerate its fields either.
  assertModuleReadAccess(principal, moduleSlug);
  const module = await requireModule(moduleSlug);

  // Deleted fields exist only for the admin field manager; everyone else has
  // no business knowing a field ever existed.
  if (opts.includeDeleted) assertConfigPermission(principal, 'FIELD');

  const fields = await prisma.fieldDefinition.findMany({
    where: { moduleId: module.id, ...(opts.includeDeleted ? {} : { isDeleted: false }) },
    include: WITH_OPTIONS,
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  });

  // Hiding a field in the UI is not a security control — strip it HERE so a
  // hidden field never leaves the server. Admins get an empty set back.
  const hidden = new PermissionEngine(principal.actor, principal.permissions).hiddenFields(moduleSlug);
  return fields.filter((f) => !hidden.has(f.key)).map(toDto);
}

// ── create ────────────────────────────────────────────────────────────────

export async function createField(
  principal: Principal,
  moduleSlug: string,
  input: FieldCreateInput,
): Promise<{ field: FieldDto; warning?: string }> {
  // Fail closed BEFORE touching data. applyConfigChange asserts again, but
  // everything a mutation does on its way there — module lookups, existence
  // checks, the dependency scan — answers questions an unauthorised caller
  // must not get to ask. Every mutation in this file opens with this line.
  assertConfigPermission(principal, 'FIELD');
  const module = await requireModule(moduleSlug);
  await assertSection(input.sectionId, module.id);

  const { result } = await applyConfigChange<{ field: FieldDto; warning?: string }>({
    principal,
    configType: 'FIELD',
    action: 'CREATE',
    before: async () => null,
    mutate: async (tx) => {
      // Key generation reads soft-deleted rows too: their keys stay reserved
      // (matching the unique index) so restoring one can never collide.
      const existing = await tx.fieldDefinition.findMany({
        where: { moduleId: module.id },
        select: { key: true, isDeleted: true, displayOrder: true },
      });

      const activeCount = existing.filter((f) => !f.isDeleted).length;
      if (activeCount >= FIELD_CAP_HARD) {
        throw new ConfigError(
          `This module already has ${activeCount} fields — the cap is ${FIELD_CAP_HARD}. Delete unused fields first.`,
          422,
          'CAP_EXCEEDED',
        );
      }
      const warning =
        activeCount >= FIELD_CAP_SOFT
          ? `This module now has ${activeCount + 1} fields. Past ${FIELD_CAP_SOFT}, list and form performance degrade — consider retiring unused fields.`
          : undefined;

      const key = uniqueFieldKey(input.label, new Set(existing.map((f) => f.key)));
      // Max spans deleted rows too, so a later restore never lands on a
      // duplicate order slot.
      const displayOrder = existing.reduce((max, f) => Math.max(max, f.displayOrder), -1) + 1;

      const created = await tx.fieldDefinition.create({
        data: {
          moduleId: module.id,
          key,
          label: input.label,
          type: input.type,
          helpText: input.helpText ?? null,
          isRequired: input.isRequired,
          isUnique: input.isUnique,
          sectionId: input.sectionId ?? null,
          displayOrder,
          validation: jsonWrite(input.validation),
          defaultValue: jsonWrite(input.defaultValue),
          createdById: principal.actor.userId,
          options: input.options?.length
            ? {
                create: input.options.map((o, index) => ({
                  label: o.label,
                  value: o.value ?? o.label,
                  color: o.color ?? null,
                  displayOrder: index,
                })),
              }
            : undefined,
        },
        include: WITH_OPTIONS,
      });

      return { result: { field: toDto(created), warning }, configId: created.id };
    },
    after: (tx, configId) =>
      tx.fieldDefinition.findUnique({ where: { id: configId }, include: WITH_OPTIONS }),
  });

  return result;
}

// ── update ────────────────────────────────────────────────────────────────

/** What spec §4.3 locks on a system field. Rename, restyle, move and reorder
 *  stay allowed — assignment, matching and logging read the key, not these. */
const SYSTEM_LOCKED = ['isRequired', 'validation', 'defaultValue', 'options'] as const;

export async function updateField(
  principal: Principal,
  moduleSlug: string,
  fieldId: string,
  input: FieldUpdateInput,
): Promise<FieldDto> {
  assertConfigPermission(principal, 'FIELD');
  const module = await requireModule(moduleSlug);
  const field = await requireField(module.id, fieldId);

  if (field.isDeleted) {
    throw new ConfigError('Field is deleted — restore it before editing', 409, 'CONFLICT');
  }

  if (field.isSystem) {
    // Key presence, not value, is the violation: sending `isRequired: false`
    // for a system field is still an attempt to govern a locked property.
    const locked = SYSTEM_LOCKED.filter((k) => k in input);
    if (locked.length > 0) {
      throw new ConfigError(
        `System fields cannot change ${locked.join(', ')} — only label, help text, section and order are editable`,
        422,
        'GUARDRAIL',
      );
    }
  }

  if (input.options && !FIELD_TYPE_SPECS[field.type].hasOptions) {
    throw new ConfigError(
      `${FIELD_TYPE_SPECS[field.type].label} fields do not carry options`,
      422,
      'VALIDATION',
    );
  }

  // The counterpart to fieldCreateSchema's "add at least one option" refine.
  // It cannot live in fieldUpdateSchema — that payload carries no `type`, and
  // the edit overlay submits `options: []` for every non-picklist field — so
  // the type-aware half of the rule belongs here, ahead of diffOptions.
  // Every entry in the payload either restores or creates a LIVE option, so an
  // empty array is the only way to end with none, and a picklist with zero
  // live options offers an empty picker while stored values lose their labels.
  if (input.options?.length === 0 && FIELD_TYPE_SPECS[field.type].hasOptions) {
    throw new ConfigError(
      `A ${FIELD_TYPE_SPECS[field.type].label} field must keep at least one option`,
      422,
      'VALIDATION',
    );
  }

  if (input.sectionId) await assertSection(input.sectionId, module.id);

  const { result } = await applyConfigChange<FieldDto>({
    principal,
    configType: 'FIELD',
    action: 'UPDATE',
    before: (tx) =>
      tx.fieldDefinition.findUnique({ where: { id: fieldId }, include: WITH_OPTIONS }),
    mutate: async (tx) => {
      if (input.options) await diffOptions(tx, fieldId, input.options);

      const updated = await tx.fieldDefinition.update({
        where: { id: fieldId },
        data: {
          label: input.label,
          // undefined = untouched, null = cleared — both are meaningful here.
          helpText: input.helpText,
          isRequired: input.isRequired,
          sectionId: input.sectionId,
          validation: jsonWrite(input.validation),
          defaultValue: jsonWrite(input.defaultValue),
        },
        include: WITH_OPTIONS,
      });

      return { result: toDto(updated), configId: fieldId };
    },
    after: (tx, configId) =>
      tx.fieldDefinition.findUnique({ where: { id: configId }, include: WITH_OPTIONS }),
  });

  return result;
}

/**
 * Reconcile the stored option rows against the desired list. The input array
 * IS the desired state: matched ids update in place, unknown-to-the-input
 * rows soft-delete, id-less entries create. Array position becomes
 * displayOrder, so reordering options is the same PATCH as renaming one.
 */
async function diffOptions(
  tx: Tx,
  fieldId: string,
  options: NonNullable<FieldUpdateInput['options']>,
): Promise<void> {
  const existing = await tx.picklistOption.findMany({ where: { fieldDefinitionId: fieldId } });
  const byId = new Map(existing.map((o) => [o.id, o]));
  // Values are unique across deleted rows too — a colliding create must be a
  // 409 here, not a raw unique-index error surfacing as a 500.
  const usedValues = new Set(existing.map((o) => o.value));
  const seen = new Set<string>();

  for (const [index, opt] of options.entries()) {
    if (opt.id) {
      const current = byId.get(opt.id);
      if (!current) throw new ConfigError('Unknown option id', 422, 'VALIDATION');
      // Records store the VALUE, not the option id — rewriting it would orphan
      // every historical record holding the old one. Immutable, forever.
      if (opt.value !== undefined && opt.value !== current.value) {
        throw new ConfigError(
          'Option values are immutable once created — add a new option instead',
          422,
          'GUARDRAIL',
        );
      }
      seen.add(opt.id);
      await tx.picklistOption.update({
        where: { id: opt.id },
        // Re-including a soft-deleted option's id is a restore — the value
        // stayed reserved, so this can never collide.
        data: { label: opt.label, color: opt.color ?? null, displayOrder: index, isDeleted: false },
      });
    } else {
      const value = opt.value ?? opt.label;
      if (usedValues.has(value)) {
        throw new ConfigError(
          `Option value "${value}" already exists on this field (retired options keep their value)`,
          409,
          'CONFLICT',
        );
      }
      usedValues.add(value);
      await tx.picklistOption.create({
        data: {
          fieldDefinitionId: fieldId,
          label: opt.label,
          value,
          color: opt.color ?? null,
          displayOrder: index,
        },
      });
    }
  }

  // Options missing from the payload retire, never vanish — historical
  // records still hold their values (invariant 4).
  for (const o of existing) {
    if (!o.isDeleted && !seen.has(o.id)) {
      await tx.picklistOption.update({ where: { id: o.id }, data: { isDeleted: true } });
    }
  }
}

// ── delete / restore ──────────────────────────────────────────────────────

/**
 * Spec §13: before a field retires, report everything that silently degrades
 * with it, so the Admin confirms with eyes open rather than discovering a
 * broken view a week later.
 */
async function scanFieldDependencies(
  moduleId: string,
  fieldId: string,
  fieldKey: string,
): Promise<DependencyReport> {
  const [views, layouts, imports] = await Promise.all([
    prisma.savedView.findMany({
      where: { moduleId },
      select: { id: true, name: true, columns: true, filters: true },
    }),
    prisma.layout.findMany({
      where: { moduleId },
      select: { id: true, target: true, layout: true },
    }),
    prisma.importBatch.findMany({
      where: { moduleId },
      select: { id: true, filename: true, mapping: true },
    }),
  ]);

  const report: DependencyReport = { views: [], layouts: [], imports: [] };

  for (const v of views) {
    // Columns reference the field by id; the filter tree by key. Both count.
    const inColumns =
      Array.isArray(v.columns) &&
      v.columns.some(
        (c) => !!c && typeof c === 'object' && (c as { fieldId?: unknown }).fieldId === fieldId,
      );
    const inFilters =
      v.filters !== null &&
      collectFieldKeys(v.filters as unknown as FilterNode).has(fieldKey);
    if (inColumns || inFilters) report.views.push({ id: v.id, name: v.name });
  }

  for (const l of layouts) {
    if (layoutReferencesField(l.layout, fieldId)) {
      report.layouts.push({ id: l.id, target: l.target });
    }
  }

  for (const i of imports) {
    // Mapping shapes vary by importer version; a substring scan over the
    // serialised Json catches the field however it was referenced.
    const blob = JSON.stringify(i.mapping ?? {});
    if (blob.includes(fieldKey) || blob.includes(fieldId)) {
      report.imports.push({ id: i.id, filename: i.filename });
    }
  }

  return report;
}

/** Walk a stored LayoutSpec defensively — it is Json, not a trusted shape. */
function layoutReferencesField(layout: unknown, fieldId: string): boolean {
  if (!layout || typeof layout !== 'object') return false;
  const sections = (layout as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return false;
  return sections.some((section) => {
    if (!section || typeof section !== 'object') return false;
    const fields = (section as { fields?: unknown }).fields;
    return (
      Array.isArray(fields) &&
      fields.some(
        (f) => !!f && typeof f === 'object' && (f as { fieldId?: unknown }).fieldId === fieldId,
      )
    );
  });
}

export async function softDeleteField(
  principal: Principal,
  moduleSlug: string,
  fieldId: string,
  opts: { confirmed: boolean },
): Promise<FieldDto> {
  // Assert FIRST: the guardrail scan below enumerates saved-view names and
  // uploaded import filenames into the 409 body, so reaching it without the
  // permission would hand an unauthorised caller a directory of the tenant's
  // config.
  assertConfigPermission(principal, 'FIELD');
  const module = await requireModule(moduleSlug);
  const field = await requireField(module.id, fieldId);

  if (field.isSystem) {
    throw new ConfigError(
      'System fields cannot be deleted — assignment, matching and logging depend on them',
      422,
      'GUARDRAIL',
    );
  }
  if (field.isDeleted) throw new ConfigError('Field is already deleted', 409, 'CONFLICT');

  const dependencies = await scanFieldDependencies(module.id, field.id, field.key);
  const hasDependencies =
    dependencies.views.length + dependencies.layouts.length + dependencies.imports.length > 0;
  if (hasDependencies && !opts.confirmed) {
    throw new ConfigError(
      'Deleting this field affects saved views, layouts or import presets',
      409,
      'DEPENDENCIES',
      { dependencies },
    );
  }

  const { result } = await applyConfigChange<FieldDto>({
    principal,
    configType: 'FIELD',
    action: 'DELETE',
    before: (tx) =>
      tx.fieldDefinition.findUnique({ where: { id: fieldId }, include: WITH_OPTIONS }),
    mutate: async (tx) => {
      // Retire the row only. Values on records and in audit diffs are NOT
      // touched — invariant 4 — and the key stays reserved for restore.
      const updated = await tx.fieldDefinition.update({
        where: { id: fieldId },
        data: { isDeleted: true },
        include: WITH_OPTIONS,
      });
      return { result: toDto(updated), configId: fieldId };
    },
    after: (tx, configId) =>
      tx.fieldDefinition.findUnique({ where: { id: configId }, include: WITH_OPTIONS }),
  });

  return result;
}

export async function restoreField(
  principal: Principal,
  moduleSlug: string,
  fieldId: string,
): Promise<FieldDto> {
  assertConfigPermission(principal, 'FIELD');
  const module = await requireModule(moduleSlug);
  const field = await requireField(module.id, fieldId);

  if (!field.isDeleted) throw new ConfigError('Field is not deleted', 409, 'CONFLICT');

  const { result } = await applyConfigChange<FieldDto>({
    principal,
    configType: 'FIELD',
    action: 'RESTORE',
    before: (tx) =>
      tx.fieldDefinition.findUnique({ where: { id: fieldId }, include: WITH_OPTIONS }),
    mutate: async (tx) => {
      // Safe by construction: the key was never released while deleted.
      const updated = await tx.fieldDefinition.update({
        where: { id: fieldId },
        data: { isDeleted: false },
        include: WITH_OPTIONS,
      });
      return { result: toDto(updated), configId: fieldId };
    },
    after: (tx, configId) =>
      tx.fieldDefinition.findUnique({ where: { id: configId }, include: WITH_OPTIONS }),
  });

  return result;
}

// ── reorder ───────────────────────────────────────────────────────────────

export async function reorderFields(
  principal: Principal,
  moduleSlug: string,
  input: ReorderInput,
): Promise<void> {
  assertConfigPermission(principal, 'FIELD');
  const module = await requireModule(moduleSlug);

  await applyConfigChange<null>({
    principal,
    // A complete permutation is now mandatory, so the worst case is
    // FIELD_CAP_HARD sequential updates on one pooled, cross-region
    // connection — more than the default budget allows.
    timeout: 30_000,
    configType: 'FIELD',
    action: 'REORDER',
    // The snapshot is the ordered id array — enough to see AND revert a
    // reorder without dragging full field rows into the log.
    before: (tx) => orderedFieldIds(tx, module.id),
    mutate: async (tx) => {
      // The payload must list every live field of this module exactly once.
      // A partial list is not a partial reorder: the omitted fields keep their
      // old displayOrder, so the submitted subset lands on slots that are
      // already taken and the list order stops being deterministic.
      const liveIds = new Set(await orderedFieldIds(tx, module.id));
      const seen = new Set(input.orderedIds);
      const rejected = input.orderedIds.filter((id) => !liveIds.has(id));
      if (
        rejected.length > 0 ||
        seen.size !== input.orderedIds.length ||
        seen.size !== liveIds.size
      ) {
        throw new ConfigError(
          `orderedIds must list every active field of this module exactly once — got ${input.orderedIds.length} id(s) for ${liveIds.size} active field(s)`,
          422,
          'VALIDATION',
          rejected.length > 0 ? { rejectedIds: rejected } : undefined,
        );
      }

      // Sequential on purpose: interactive transactions share one connection,
      // and the array index IS the new order.
      for (const [index, id] of input.orderedIds.entries()) {
        await tx.fieldDefinition.update({ where: { id }, data: { displayOrder: index } });
      }
      return { result: null, configId: module.id };
    },
    after: (tx) => orderedFieldIds(tx, module.id),
  });
}

async function orderedFieldIds(tx: Tx, moduleId: string): Promise<string[]> {
  const fields = await tx.fieldDefinition.findMany({
    where: { moduleId, isDeleted: false },
    select: { id: true },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return fields.map((f) => f.id);
}
