/**
 * `AssignmentPorts` over Prisma — the adapter that lets the engine in
 * `packages/core` route a lead without knowing what a Group, a Role or a
 * PlatformSetting is.
 *
 * Three rules shape this file, and all three are invariant 1 wearing different
 * clothes ("nothing is ever unassigned"):
 *
 *  1. **Nothing is matched by NAME.** The spec says ARK leads go to "the
 *     Seniors of that language" and everything else falls to a "default pool",
 *     but Seniors is a role the Admin created and may rename this afternoon.
 *     So the Admin NOMINATES the rows instead — `assignment.seniorRoleId` and
 *     `assignment.defaultPoolGroupId` — and this file reads pointers. Rename
 *     the role to "Desk Leads" and routing follows, with no deploy. The one
 *     exception is `getAdminUserId`, which reads `Role.isLocked` — the same
 *     flag `isAdmin` is derived from everywhere else, never the string
 *     "Admin".
 *  2. **Only ACTIVE users are candidates.** A deactivated user still owns
 *     their history (invariant 4) but must never receive new work; handing
 *     them a lead is the same dead end as leaving it unassigned.
 *  3. **An unset pointer is not an error.** It returns the empty list, the
 *     strategy falls to the next tier, and the last tier is the Admin.
 */
import 'server-only';
import type { AssignmentPorts } from '@crm/core';
import type { AssignmentSettings } from '@crm/shared';
import { ConfigError, type Tx } from '@/lib/config/service';

/**
 * The Prisma-backed ports, bound to ONE transaction and one settings read.
 *
 * Short-lived by design: it is constructed per assignment, inside the
 * transaction that writes the record, so the rota advance and the record
 * insert commit together. A create that rolls back must not burn a position in
 * the rotation.
 */
export class PrismaAssignmentPorts implements AssignmentPorts {
  /**
   * The candidate list the last finder produced.
   *
   * `AssignmentPorts.nextIndex(key, size)` returns an INDEX, but
   * `AssignmentState` stores the last assigned USER — deliberately, see
   * `nextIndex` — so the port has to map between the two, which means knowing
   * which people the index is an index INTO. `LanguageRoundRobin` calls a
   * finder and then immediately calls `nextIndex` with that list's length, so
   * remembering the last list is exact rather than approximate, and the size
   * check in `nextIndex` turns any future strategy that breaks that pairing
   * into a loud failure instead of a silently unfair rota.
   */
  private candidates: string[] = [];

  constructor(
    private readonly tx: Tx,
    private readonly settings: AssignmentSettings,
  ) {}

  /** Record a candidate list on its way out, so `nextIndex` can position
   *  `lastAssignedUserId` inside it. */
  private remember(memberIds: string[]): string[] {
    this.candidates = memberIds;
    return memberIds;
  }

  /**
   * The live group serving this language, with its ACTIVE members.
   *
   * Matched case-insensitively because `Group.language` is typed by hand in
   * the Groups screen while a lead's language comes from a picker: "hindi" and
   * "Hindi" are the same team to everyone except a byte comparison, and a miss
   * here silently sends a whole language to the default pool. Ordered by name
   * so that two groups claiming one language resolve deterministically rather
   * than by whatever the planner returns first.
   */
  async findGroupForLanguage(
    language: string,
  ): Promise<{ id: string; memberIds: string[] } | null> {
    const wanted = language.trim();
    // A module with no language field asks with the empty string. There is no
    // group for "no language", and matching one would be a coincidence.
    if (wanted === '') return null;

    const group = await this.tx.group.findFirst({
      where: { isDeleted: false, language: { equals: wanted, mode: 'insensitive' } },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        members: {
          where: { user: { isActive: true } },
          // STABLE order, or the rota jumps: the next position is derived from
          // where the last assigned user sits in this list, so the list has to
          // mean the same thing on the next call.
          orderBy: { userId: 'asc' },
          select: { userId: true },
        },
      },
    });
    if (!group) return null;

    // A group with no active members returns empty rather than null: the
    // strategy treats both the same way and falls through to the pool.
    return { id: group.id, memberIds: this.remember(group.members.map((m) => m.userId)) };
  }

  /**
   * The senior pool for this language: active holders of the NOMINATED role
   * who speak it.
   *
   * Returns [] when no role has been nominated — routing then falls to the
   * default pool, which is the correct answer for a client who has not yet
   * said which role their seniors hold. Never a name lookup; see the header.
   *
   * The language test is an exact array containment because both sides come
   * from the same language picker (`User.languages`, spec §5.4), unlike
   * `Group.language` above which is typed free-hand.
   */
  async findSeniorsForLanguage(language: string): Promise<string[]> {
    const roleId = this.settings.seniorRoleId;
    const wanted = language.trim();
    if (!roleId || wanted === '') return this.remember([]);

    const seniors = await this.tx.user.findMany({
      where: { isActive: true, roleId, languages: { has: wanted } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return this.remember(seniors.map((u) => u.id));
  }

  /** Active members of the nominated default-pool group, or [] when the Admin
   *  has not nominated one — the tier below is the Admin, so this never has to
   *  invent anybody. */
  async findDefaultPoolMembers(): Promise<string[]> {
    const groupId = this.settings.defaultPoolGroupId;
    if (!groupId) return this.remember([]);

    const members = await this.tx.groupMember.findMany({
      where: { groupId, group: { isDeleted: false }, user: { isActive: true } },
      orderBy: { userId: 'asc' },
      select: { userId: true },
    });
    return this.remember(members.map((m) => m.userId));
  }

  /**
   * The last resort. A lead is never unassigned, not even for a second.
   *
   * "Admin" is read as `Role.isLocked` — the seeded Admin role is the only
   * locked role and `isAdmin` is derived from that same flag in
   * `lib/auth/actor.ts`. Ordered by id so the fallback is the same person on
   * every call rather than whoever the planner returned first; a rotating
   * fallback would make "why did this land here" unanswerable.
   *
   * THROWS rather than returning an empty string. Last-admin protection
   * (`assertAnotherAdminRemains`) means an installation cannot reach this
   * state, so if it ever happens the database is broken — and writing a bogus
   * owner id into `Lead.ownerId` would be worse than failing: the FK would
   * reject it anyway, one layer later, with nothing to say about why.
   */
  async getAdminUserId(): Promise<string> {
    const admin = await this.tx.user.findFirst({
      where: { isActive: true, role: { isLocked: true } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!admin) {
      throw new ConfigError(
        'No active administrator exists to own this record',
        500,
        'GUARDRAIL',
      );
    }
    return admin.id;
  }

  /**
   * Advance the rota one position and return where it landed. THE HARD PART.
   *
   * **Why the state is a user id and not an index.** `AssignmentState` stores
   * `lastAssignedUserId`. An index would be wrong the moment a member leaves
   * the group: position 3 of 5 is a different person once someone is removed
   * or deactivated, so the rota would silently skip and repeat people on every
   * membership change. A user id survives all of it — the next position is
   * "one past wherever that person sits in TODAY's list", and if that person
   * has left the list entirely the rota restarts at position 0.
   *
   * **Why one statement.** ARK posts in bursts and campaign leads arrive in
   * parallel; a read-then-write would let two concurrent creates read the same
   * `lastAssignedUserId` and hand both leads to the same person while skipping
   * the next. `INSERT ... ON CONFLICT DO UPDATE` computes the next position
   * FROM THE STORED ROW inside a single statement, and Postgres takes a row
   * lock on the conflicting key: the second transaction blocks until the first
   * commits and then reads the value the first wrote. No lost update, no
   * skipped member, no advisory lock to leak.
   *
   * The statement runs on the caller's transaction, so the lock is held until
   * that transaction commits — which is exactly what makes the advance atomic
   * with the record it assigned. Concurrent creates against the SAME group
   * serialise for the length of one insert; creates against different groups
   * use different keys and never touch.
   *
   * `array_position` returns NULL when the stored user is no longer a member
   * (they left, or were deactivated out of the candidate list), and COALESCE
   * turns that into position 0 — the restart described above. Postgres arrays
   * are 1-based, hence the `+ 1`.
   */
  async nextIndex(key: string, size: number): Promise<number> {
    const members = this.candidates;
    if (size <= 0 || members.length !== size) {
      // Unreachable with `LanguageRoundRobin`, which always advances the list
      // it just fetched. Loud rather than silent: guessing here would hand
      // every lead in a language to one person and look like bad luck.
      throw new ConfigError(
        `Assignment rota "${key}" was advanced against a candidate list it does not match`,
        500,
        'GUARDRAIL',
      );
    }

    const rows = await this.tx.$queryRaw<{ lastAssignedUserId: string | null }[]>`
      INSERT INTO "AssignmentState" ("key", "lastAssignedUserId", "updatedAt")
      VALUES (${key}, (${members}::text[])[1], now())
      ON CONFLICT ("key") DO UPDATE SET
        "lastAssignedUserId" = (${members}::text[])[
          (COALESCE(
            array_position(${members}::text[], "AssignmentState"."lastAssignedUserId"),
            0
          ) % ${size}::int) + 1
        ],
        "updatedAt" = now()
      RETURNING "lastAssignedUserId"
    `;

    const chosen = rows[0]?.lastAssignedUserId ?? null;
    const index = chosen === null ? -1 : members.indexOf(chosen);
    // The id came out of `members`, so this cannot miss; 0 is the same answer
    // the SQL gives for "the stored user is not in the list" and keeps the
    // caller assigning rather than throwing.
    return index >= 0 ? index : 0;
  }
}
