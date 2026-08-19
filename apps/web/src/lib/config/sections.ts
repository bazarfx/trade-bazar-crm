/**
 * Form-section configuration ops.
 *
 * Sections are pure presentation — a grid card the layout resolver hangs
 * fields on — so every mutation here is config, and every mutation funnels
 * through `applyConfigChange` (configType SECTION) for the permission check,
 * the before/after snapshot and the undo support.
 */
import 'server-only';
import { prisma } from '@crm/db';
import type { ReorderInput, SectionCreateInput, SectionUpdateInput } from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { assertModuleReadAccess } from '@/lib/config/access';
import { applyConfigChange, ConfigError, requireModule, type Tx } from '@/lib/config/service';

/** Ordered, non-deleted sections — what the builder and the form both render. */
export async function listSections(principal: Principal, moduleSlug: string) {
  // Sections are needed to render any form of this module — and only by
  // someone who may see this module at all.
  assertModuleReadAccess(principal, moduleSlug);
  const module = await requireModule(moduleSlug);
  return prisma.formSection.findMany({
    where: { moduleId: module.id, isDeleted: false },
    orderBy: { displayOrder: 'asc' },
  });
}

/** Load a live section of THIS module or 404 — a foreign or deleted id must
 *  not be reachable through another module's URL. */
async function requireSection(tx: Tx, moduleId: string, sectionId: string) {
  const section = await tx.formSection.findFirst({
    where: { id: sectionId, moduleId, isDeleted: false },
  });
  if (!section) throw new ConfigError('Section not found', 404, 'NOT_FOUND');
  return section;
}

/** The order snapshot logged around a reorder, so the change viewer can show
 *  the move and an admin can reconstruct the old order by hand if ever needed. */
async function orderSnapshot(tx: Tx, moduleId: string) {
  return tx.formSection.findMany({
    where: { moduleId, isDeleted: false },
    orderBy: { displayOrder: 'asc' },
    select: { id: true, label: true, displayOrder: true },
  });
}

export async function createSection(
  principal: Principal,
  moduleSlug: string,
  input: SectionCreateInput,
) {
  const module = await requireModule(moduleSlug);

  const { result } = await applyConfigChange({
    principal,
    configType: 'SECTION',
    action: 'CREATE',
    before: async () => null,
    mutate: async (tx) => {
      // append after every existing section, deleted ones included, so a
      // later restore never collides on displayOrder
      const max = await tx.formSection.aggregate({
        where: { moduleId: module.id },
        _max: { displayOrder: true },
      });
      const section = await tx.formSection.create({
        data: {
          moduleId: module.id,
          label: input.label,
          columns: input.columns,
          isCollapsible: input.isCollapsible,
          displayOrder: (max._max.displayOrder ?? -1) + 1,
        },
      });
      return { result: section, configId: section.id };
    },
    after: (tx, id) => tx.formSection.findUnique({ where: { id } }),
  });

  return result;
}

export async function updateSection(
  principal: Principal,
  moduleSlug: string,
  sectionId: string,
  input: SectionUpdateInput,
) {
  const module = await requireModule(moduleSlug);

  const { result } = await applyConfigChange({
    principal,
    configType: 'SECTION',
    action: 'UPDATE',
    before: (tx) => requireSection(tx, module.id, sectionId),
    mutate: async (tx) => {
      await requireSection(tx, module.id, sectionId);
      const section = await tx.formSection.update({
        where: { id: sectionId },
        data: {
          label: input.label,
          columns: input.columns,
          isCollapsible: input.isCollapsible,
        },
      });
      return { result: section, configId: section.id };
    },
    after: (tx, id) => tx.formSection.findUnique({ where: { id } }),
  });

  return result;
}

export async function softDeleteSection(
  principal: Principal,
  moduleSlug: string,
  sectionId: string,
) {
  const module = await requireModule(moduleSlug);

  const { result } = await applyConfigChange({
    principal,
    configType: 'SECTION',
    action: 'DELETE',
    before: (tx) => requireSection(tx, module.id, sectionId),
    mutate: async (tx) => {
      await requireSection(tx, module.id, sectionId);

      // A form must always have somewhere to render fields — the layout
      // resolver reassigns orphaned fields to a live section at read time,
      // but it cannot conjure a section out of nothing.
      const remaining = await tx.formSection.count({
        where: { moduleId: module.id, isDeleted: false, id: { not: sectionId } },
      });
      if (remaining === 0) {
        throw new ConfigError(
          'Cannot delete the last section — a form must keep at least one.',
          422,
          'GUARDRAIL',
        );
      }

      // Fields KEEP their sectionId on purpose: restoring the section puts
      // them straight back, and until then the resolver re-homes them.
      const section = await tx.formSection.update({
        where: { id: sectionId },
        data: { isDeleted: true },
      });
      return { result: section, configId: section.id };
    },
    after: (tx, id) => tx.formSection.findUnique({ where: { id } }),
  });

  return result;
}

/** Reorder every live section in one gesture. Returns the fresh order. */
export async function reorderSections(
  principal: Principal,
  moduleSlug: string,
  input: ReorderInput,
) {
  const module = await requireModule(moduleSlug);

  const { result } = await applyConfigChange({
    principal,
    configType: 'SECTION',
    action: 'REORDER',
    // configId is the MODULE id: a reorder is a property of the whole section
    // list, not of one row. The generic single-row revert cannot apply here,
    // so the snapshots below are what makes the change auditable.
    before: (tx) => orderSnapshot(tx, module.id),
    mutate: async (tx) => {
      const live = await tx.formSection.findMany({
        where: { moduleId: module.id, isDeleted: false },
        select: { id: true },
      });
      const liveIds = new Set(live.map((s) => s.id));

      // the payload must be exactly the live sections, each exactly once —
      // a partial or duplicated order is ambiguous, and an unknown id could
      // silently reorder another module's form
      const seen = new Set<string>();
      const rejected: string[] = [];
      for (const id of input.orderedIds) {
        if (!liveIds.has(id) || seen.has(id)) rejected.push(id);
        seen.add(id);
      }
      if (rejected.length > 0 || seen.size !== liveIds.size) {
        throw new ConfigError(
          'orderedIds must list every active section of this module exactly once',
          422,
          'VALIDATION',
          rejected.length > 0 ? { rejectedIds: rejected } : undefined,
        );
      }

      for (const [index, id] of input.orderedIds.entries()) {
        await tx.formSection.update({ where: { id }, data: { displayOrder: index } });
      }

      const sections = await tx.formSection.findMany({
        where: { moduleId: module.id, isDeleted: false },
        orderBy: { displayOrder: 'asc' },
      });
      return { result: sections, configId: module.id };
    },
    after: (tx) => orderSnapshot(tx, module.id),
  });

  return result;
}
