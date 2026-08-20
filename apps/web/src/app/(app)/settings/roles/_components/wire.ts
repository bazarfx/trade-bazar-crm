import type { SpecialPermission, ViewScope } from '@crm/shared';

/**
 * The wire shapes the roles screens read, plus the two display maps they need.
 *
 * These are REDECLARED here rather than imported from `@/lib/config/roles`:
 * that module carries `import 'server-only'`, and even a type-only import puts
 * it in the bundler's resolution graph for a `'use client'` module. Same
 * reasoning as `TableRow` in the record table.
 *
 * Nothing in this file names a module, a role or a permission an Admin can
 * rename — modules arrive from the matrix response and specials from
 * SPECIAL_PERMISSIONS, so a module invented in 2027 renders without a deploy.
 */

/**
 * `extends Record<string, unknown>` is what lets this satisfy `DataTable`'s
 * row constraint: TypeScript grants an implicit index signature to type
 * aliases but never to an interface, so a plain interface would not assign.
 */
export interface RoleRow extends Record<string, unknown> {
  id: string;
  name: string;
  isLocked: boolean;
  isDeleted: boolean;
  userCount: number;
  /** Modules this role can actually see — a row parked at NONE is not counted. */
  moduleCount: number;
  specialCount: number;
}

/** `POST /api/roles` and `PATCH /api/roles/[roleId]` answer with this. */
export interface RoleDto {
  id: string;
  name: string;
  isLocked: boolean;
  isDeleted: boolean;
}

/** One row of the grid: what this role may do inside one module. */
export interface MatrixModule {
  moduleId: string;
  slug: string;
  label: string;
  labelPlural: string;
  viewScope: ViewScope;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  hiddenFieldIds: string[];
  readonlyFieldIds: string[];
}

export interface MatrixResponse {
  role: RoleDto;
  modules: MatrixModule[];
  specials: SpecialPermission[];
}

/** The slice of `FieldDto` the field-rules editor renders. */
export interface RuleField {
  id: string;
  key: string;
  label: string;
  isSystem: boolean;
  isDeleted: boolean;
}

/**
 * `ViewScope` is a CODE enum, not Admin data — the five values are the ones
 * `PermissionEngine.scopeFilter` branches on and no UI can add a sixth. So a
 * label map is legitimate here in a way a status or field label never is.
 * Typed as a total `Record` on purpose: growing VIEW_SCOPES without a label
 * becomes a type error rather than a blank option in the picker.
 */
export const SCOPE_LABEL: Record<ViewScope, string> = {
  NONE: 'None',
  OWN: 'Own records',
  GROUP: 'Group',
  DEPARTMENT: 'Department',
  ALL: 'All records',
};

/** One line of plain English per scope, shown under the grid. */
export const SCOPE_HELP: Record<ViewScope, string> = {
  NONE: 'sees nothing in this module',
  OWN: 'sees only the records they own',
  GROUP: 'sees records owned by anyone in their groups',
  DEPARTMENT: 'sees records owned by anyone in their department',
  ALL: 'sees every record in the module',
};

/** Every `data-track` on these screens starts here: `settings.roles.*`. */
export const TRACK = 'settings.roles';

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
