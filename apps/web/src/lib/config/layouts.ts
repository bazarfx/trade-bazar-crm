/**
 * Layout lookup, resolution and save.
 *
 * A stored Layout row is a HINT over the field list, never the truth — the
 * reconciliation lives in @crm/core resolveLayout(). This file only decides
 * WHICH hint applies (role row first, module row second, none last) and
 * guards the write path.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import {
  layoutSpecSchema,
  type LayoutSaveInput,
  type LayoutSpec,
  type LayoutTargetValue,
} from '@crm/shared';
import { PermissionEngine, resolveLayout, type ResolvedSection } from '@crm/core';
import type { Principal } from '@/lib/auth/actor';
import { assertModuleReadAccess } from '@/lib/config/access';
import { applyConfigChange, ConfigError, requireModule } from '@/lib/config/service';

export interface LayoutLookup {
  spec: LayoutSpec | null;
  source: 'role' | 'module' | 'none';
}

/** A corrupt stored spec behaves like no spec at all: the resolver falls back
 *  to plain field order, which always renders. Never throw over bad Json. */
function parseSpec(raw: unknown): LayoutSpec | null {
  if (raw == null) return null;
  const parsed = layoutSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The layout that applies for (module, target, role): the exact role row wins,
 * else the module-wide row (roleId null), else none. A corrupt role row falls
 * through to the module row rather than blanking the form.
 */
export async function getLayout(
  principal: Principal,
  moduleSlug: string,
  target: LayoutTargetValue,
  roleId: string | null,
): Promise<LayoutLookup> {
  // Reading a layout needs no config special — writing does — but it does
  // need visibility of the module: the spec names its fields and sections.
  assertModuleReadAccess(principal, moduleSlug);
  const module = await requireModule(moduleSlug);

  if (roleId) {
    const row = await prisma.layout.findFirst({
      where: { moduleId: module.id, target, roleId, isActive: true },
    });
    const spec = parseSpec(row?.layout);
    if (spec) return { spec, source: 'role' };
  }

  const fallback = await prisma.layout.findFirst({
    where: { moduleId: module.id, target, roleId: null, isActive: true },
  });
  const spec = parseSpec(fallback?.layout);
  if (spec) return { spec, source: 'module' };

  return { spec: null, source: 'none' };
}

/**
 * The sections the current actor actually sees on a form or detail page.
 * Hidden fields are stripped BEFORE the resolver runs — a hidden field must
 * never even reach it, let alone the client.
 */
export async function resolveModuleLayout(
  principal: Principal,
  moduleSlug: string,
  target: LayoutTargetValue,
): Promise<ResolvedSection[]> {
  // Asserted here as well as in getLayout: the field and section queries below
  // start concurrently with it, so this entry point has to guard itself.
  assertModuleReadAccess(principal, moduleSlug);
  const module = await requireModule(moduleSlug);
  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const hidden = engine.hiddenFields(moduleSlug);

  const [fields, sections, lookup] = await Promise.all([
    // deleted rows are fetched on purpose: the resolver is the one place
    // that knows a stale layout may still reference them
    prisma.fieldDefinition.findMany({
      where: { moduleId: module.id },
      select: { id: true, key: true, sectionId: true, displayOrder: true, isDeleted: true },
    }),
    prisma.formSection.findMany({
      where: { moduleId: module.id },
      select: { id: true, label: true, columns: true, displayOrder: true, isDeleted: true },
    }),
    getLayout(principal, moduleSlug, target, principal.actor.roleId),
  ]);

  const visible = fields.filter((f) => !hidden.has(f.key));
  return resolveLayout(visible, sections, lookup.spec);
}

/** Create or replace the (module, target, role) layout row. */
export async function saveLayout(
  principal: Principal,
  moduleSlug: string,
  input: LayoutSaveInput,
) {
  const module = await requireModule(moduleSlug);
  const roleId = input.roleId ?? null;

  if (roleId) {
    // fail before the FK does — a dangling roleId should be a 422, not a 500
    const role = await prisma.role.findFirst({
      where: { id: roleId, isDeleted: false },
      select: { id: true },
    });
    if (!role) throw new ConfigError('Unknown role', 422, 'VALIDATION');
  }

  // Every id in the spec must belong to THIS module. A foreign field id would
  // be harmless to render (the resolver drops it) but poisonous to keep: it
  // leaks another module's internals into this module's config.
  const sectionIds = input.layout.sections.map((s) => s.sectionId);
  const fieldIds = input.layout.sections.flatMap((s) => s.fields.map((f) => f.fieldId));

  const [ownSections, ownFields] = await Promise.all([
    prisma.formSection.findMany({
      where: { id: { in: sectionIds }, moduleId: module.id },
      select: { id: true },
    }),
    prisma.fieldDefinition.findMany({
      where: { id: { in: fieldIds }, moduleId: module.id },
      select: { id: true },
    }),
  ]);
  const okSection = new Set(ownSections.map((s) => s.id));
  const okField = new Set(ownFields.map((f) => f.id));
  const foreign = [
    ...new Set([
      ...sectionIds.filter((id) => !okSection.has(id)),
      ...fieldIds.filter((id) => !okField.has(id)),
    ]),
  ];
  if (foreign.length > 0) {
    throw new ConfigError(
      `Layout references ids that do not belong to this module: ${foreign.join(', ')}`,
      422,
      'VALIDATION',
      { foreignIds: foreign },
    );
  }

  // Prisma cannot upsert on a unique key with a null member (roleId), so the
  // upsert is spelled by hand: findFirst inside the tx, then create or update.
  const existing = await prisma.layout.findFirst({
    where: { moduleId: module.id, target: input.target, roleId },
    select: { id: true },
  });

  const { result } = await applyConfigChange({
    principal,
    configType: 'LAYOUT',
    action: existing ? 'UPDATE' : 'CREATE',
    before: async (tx) =>
      existing ? tx.layout.findUnique({ where: { id: existing.id } }) : null,
    mutate: async (tx) => {
      // re-check inside the tx so a concurrent first save updates instead of
      // tripping the unique constraint
      const current = await tx.layout.findFirst({
        where: { moduleId: module.id, target: input.target, roleId },
        select: { id: true },
      });
      const data = {
        layout: input.layout as unknown as Prisma.InputJsonValue,
        isActive: true,
      };
      const row = current
        ? await tx.layout.update({ where: { id: current.id }, data })
        : await tx.layout.create({
            data: { moduleId: module.id, target: input.target, roleId, ...data },
          });
      return { result: row, configId: row.id };
    },
    after: (tx, id) => tx.layout.findUnique({ where: { id } }),
  });

  return result;
}
