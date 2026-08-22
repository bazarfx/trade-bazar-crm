import type { DepartmentDto } from '@crm/shared';

/**
 * The wire shape of `/api/departments`, defined ONCE in `@crm/shared` and
 * re-exported here so the screen's imports stay local.
 *
 * `DepartmentRow` is the mapped-type form the generic `DataTable` accepts —
 * an interface carries no implicit index signature; see `groups/types.ts`.
 */
export type { DepartmentDto };
export type DepartmentRow = Pick<DepartmentDto, keyof DepartmentDto>;
