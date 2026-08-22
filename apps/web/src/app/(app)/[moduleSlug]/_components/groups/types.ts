import type { GroupDto, GroupMemberDto } from '@crm/shared';

/**
 * The wire shapes of `/api/groups`, defined ONCE in `@crm/shared` and
 * re-exported here so the screen's imports stay local.
 *
 * `GroupRow` exists because `DataTable` is generic over
 * `Record<string, unknown>`, and an INTERFACE has no implicit index signature
 * while a mapped type does. `Pick<GroupDto, keyof GroupDto>` is the same
 * members as an anonymous object type, which is what the table accepts — and
 * every `GroupDto` is assignable to it, so the API's rows pass straight
 * through.
 */
export type { GroupDto, GroupMemberDto };
export type GroupRow = Pick<GroupDto, keyof GroupDto>;

/**
 * `/api/users` as the add-member picker needs it. Every person-field is
 * nullable because every person-field is HIDEABLE on the Profile module: a
 * role whose matrix hides `email` gets null for it, and a hidden field never
 * leaves the server. Declared here rather than imported from the lib because
 * the lib is `server-only` — see `directory.ts` for the same reasoning.
 */
export type PickerUser = {
  id: string;
  fullName: string | null;
  email: string | null;
  isActive: boolean | null;
  roleName: string | null;
};

/**
 * What to print for a person. Never the id when there is anything better, and
 * never a hardcoded "Unknown": an id at least resolves in the audit log.
 */
export function personLabel(p: { fullName: string | null; email: string | null }, id: string): string {
  return p.fullName ?? p.email ?? id;
}
