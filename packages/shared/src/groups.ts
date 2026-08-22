import { z } from 'zod';

/**
 * Departments and Groups — the Profile module's team sub-modules (spec §5.2,
 * §5.3).
 *
 * Defined ONCE here so the Profile screens, the route handlers and the config
 * services agree on what a valid team is. Nothing in this file names a group,
 * a department or a language: every one of them is a row the Admin creates,
 * renames and retires, and they travel as ids and free strings.
 *
 * Groups carry weight beyond labelling. They are the backbone of assignment —
 * a campaign lead round-robins inside the live group whose `language` matches
 * it — so the shapes below are what lets the Admin steer routing from the UI
 * rather than from psql.
 */

// ── groups ────────────────────────────────────────────────────────────────

/**
 * `language` is a free string, not an enum: the language list is Admin-
 * editable seed data and the assignment engine matches it case-insensitively.
 * An empty string collapses to null so a cleared form control means "this
 * group serves no language" rather than a group that matches nothing forever.
 */
const groupLanguageSchema = z
  .string()
  .trim()
  .max(50)
  .nullish()
  .transform((value) => (value ? value : null));

export const groupCreateSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(80),
  language: groupLanguageSchema,
});
export type GroupCreateInput = z.infer<typeof groupCreateSchema>;

/** `.strict()` so a client cannot post `isDeleted` — retirement is an
 *  operation with guardrails, never a field edit. */
export const groupUpdateSchema = groupCreateSchema.partial().strict();
export type GroupUpdateInput = z.infer<typeof groupUpdateSchema>;

/**
 * The add/remove member payload (spec §5.3: "add/remove member controls").
 * 500 is a ceiling on one gesture, not on a team: a bigger team is built in
 * more than one request, and a hand-edited payload cannot become a full scan.
 */
export const groupMembersSchema = z
  .object({
    userIds: z.array(z.string().uuid()).min(1, 'Choose at least one user').max(500),
  })
  .strict();
export type GroupMembersInput = z.infer<typeof groupMembersSchema>;

/** What the Groups screen renders. Counts are live aggregates, never stored. */
export interface GroupDto {
  id: string;
  name: string;
  language: string | null;
  /** every member, active or not — the team as the Admin built it */
  memberCount: number;
  /** members the assignment engine will actually hand a lead to */
  activeMemberCount: number;
  /** true when `assignment.defaultPoolGroupId` names this group */
  isDefaultPool: boolean;
  isDeleted: boolean;
}

export interface GroupMemberDto {
  userId: string;
  fullName: string;
  email: string;
  isActive: boolean;
  roleName: string;
}

/**
 * A create or update answers with the group AND, when another live group
 * already serves the same language, a warning naming it. Not an error: spec
 * §5.3 says groups are freeform, so the overlap is legal — but the assignment
 * engine can only ever route a language to ONE of them, and the Admin should
 * hear that from the screen rather than from a team that stops receiving
 * leads. See `languageWarning` in the groups service for the rule.
 */
export interface GroupWriteResult {
  group: GroupDto;
  warning?: string;
}

// ── departments ───────────────────────────────────────────────────────────

export const departmentCreateSchema = z.object({
  name: z.string().trim().min(1, 'Department name is required').max(80),
});
export type DepartmentCreateInput = z.infer<typeof departmentCreateSchema>;

export const departmentUpdateSchema = departmentCreateSchema.partial().strict();
export type DepartmentUpdateInput = z.infer<typeof departmentUpdateSchema>;

export interface DepartmentDto {
  id: string;
  name: string;
  /** users whose `departmentId` points here, active or not */
  userCount: number;
  isDeleted: boolean;
}
