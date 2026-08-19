import type { ActorContext, RecordAction, SpecialPermission, ViewScope } from '@crm/shared';

/**
 * The single choke point. Every read and every write passes through here.
 *
 * CRITICAL: `scopeFilter` is applied in the REPOSITORY layer, never in a
 * controller. A controller can be forgotten; a repository cannot.
 * `visibleFields` is applied on SERIALISATION, so a hidden field never leaves
 * the server — hiding it in the UI is not a security control.
 */

export interface ModulePermission {
  moduleSlug: string;
  viewScope: ViewScope;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  hiddenFields: string[];
  readonlyFields: string[];
}

export interface PermissionSet {
  modules: Map<string, ModulePermission>;
  specials: Set<SpecialPermission>;
}

/** Shape a record must expose for ownership checks. */
export interface OwnedRecord {
  ownerId?: string | null;
  groupId?: string | null;
  departmentId?: string | null;
}

export class PermissionEngine {
  constructor(
    private readonly actor: ActorContext,
    private readonly perms: PermissionSet,
  ) {}

  /** Admin's role is seeded with everything and is locked — it short-circuits. */
  private get isAdmin(): boolean {
    return this.actor.isAdmin;
  }

  can(action: RecordAction, moduleSlug: string, record?: OwnedRecord): boolean {
    if (this.isAdmin) return true;

    const p = this.perms.modules.get(moduleSlug);
    if (!p) return false;

    if (action === 'create') return p.canCreate;
    if (p.viewScope === 'NONE') return false;

    // for edit/delete we need both the flag and scope over this specific record
    if (action === 'edit' && !p.canEdit) return false;
    if (action === 'delete' && !p.canDelete) return false;

    return record ? this.inScope(p.viewScope, record) : true;
  }

  hasSpecial(permission: SpecialPermission): boolean {
    return this.isAdmin || this.perms.specials.has(permission);
  }

  private inScope(scope: ViewScope, r: OwnedRecord): boolean {
    switch (scope) {
      case 'ALL':        return true;
      case 'OWN':        return r.ownerId === this.actor.userId;
      case 'GROUP':      return !!r.groupId && this.actor.groupIds.includes(r.groupId);
      case 'DEPARTMENT': return !!r.departmentId && r.departmentId === this.actor.departmentId;
      case 'NONE':       return false;
    }
  }

  /**
   * Prisma `where` fragment enforcing the actor's view scope.
   * Returned object is ANDed into every list and detail query by the repository.
   */
  scopeFilter(moduleSlug: string): Record<string, unknown> {
    if (this.isAdmin) return {};

    const p = this.perms.modules.get(moduleSlug);
    // no permission row = see nothing. Fail closed, never open.
    if (!p || p.viewScope === 'NONE') return { id: { in: [] } };

    switch (p.viewScope) {
      case 'ALL':        return {};
      case 'OWN':        return { ownerId: this.actor.userId };
      case 'GROUP':      return { groupId: { in: this.actor.groupIds } };
      case 'DEPARTMENT': return { owner: { departmentId: this.actor.departmentId } };
    }
  }

  /** Field keys this actor may not see. Applied on serialisation. */
  hiddenFields(moduleSlug: string): Set<string> {
    if (this.isAdmin) return new Set();
    return new Set(this.perms.modules.get(moduleSlug)?.hiddenFields ?? []);
  }

  readonlyFields(moduleSlug: string): Set<string> {
    if (this.isAdmin) return new Set();
    return new Set(this.perms.modules.get(moduleSlug)?.readonlyFields ?? []);
  }

  /** Strip hidden fields from an outbound record. */
  serialise<T extends Record<string, unknown>>(moduleSlug: string, record: T): Partial<T> {
    const hidden = this.hiddenFields(moduleSlug);
    if (hidden.size === 0) return record;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) if (!hidden.has(k)) out[k] = v;
    return out as Partial<T>;
  }
}
