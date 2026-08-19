/**
 * Assignment. Phase 1 is language-group round-robin.
 *
 * INVARIANT: nothing is ever unassigned. Every path returns an owner, and the
 * final fallback is the Admin. If you find yourself returning null here, the
 * implementation is wrong.
 *
 * Phase 2's rules engine becomes a second implementation of this interface —
 * the Leads module never changes.
 */

export interface AssignmentCandidate {
  userId: string;
  isActive: boolean;
}

export interface AssignmentRequest {
  moduleSlug: string;
  language: string;
  /** CAMPAIGN leads route to the language group; ARK_TERMINAL routes to Seniors */
  source: 'CAMPAIGN' | 'ARK_TERMINAL';
}

export interface AssignmentResult {
  ownerId: string;
  groupId: string | null;
  /** why — written straight onto the timeline */
  reason: 'group_round_robin' | 'senior_round_robin' | 'default_pool' | 'admin_fallback';
}

export interface AssignmentPorts {
  findGroupForLanguage(language: string): Promise<{ id: string; memberIds: string[] } | null>;
  findSeniorsForLanguage(language: string): Promise<string[]>;
  findDefaultPoolMembers(): Promise<string[]>;
  getAdminUserId(): Promise<string>;
  /** atomically advance and return the next index for a round-robin key */
  nextIndex(key: string, size: number): Promise<number>;
}

export interface AssignmentStrategy {
  assign(req: AssignmentRequest): Promise<AssignmentResult>;
}

export class LanguageRoundRobin implements AssignmentStrategy {
  constructor(private readonly ports: AssignmentPorts) {}

  async assign(req: AssignmentRequest): Promise<AssignmentResult> {
    if (req.source === 'CAMPAIGN') {
      const group = await this.ports.findGroupForLanguage(req.language);
      if (group && group.memberIds.length > 0) {
        const i = await this.ports.nextIndex(`${req.moduleSlug}:group:${group.id}`, group.memberIds.length);
        return { ownerId: group.memberIds[i]!, groupId: group.id, reason: 'group_round_robin' };
      }
    } else {
      const seniors = await this.ports.findSeniorsForLanguage(req.language);
      if (seniors.length > 0) {
        const i = await this.ports.nextIndex(`senior:${req.language}`, seniors.length);
        return { ownerId: seniors[i]!, groupId: null, reason: 'senior_round_robin' };
      }
    }

    const pool = await this.ports.findDefaultPoolMembers();
    if (pool.length > 0) {
      const i = await this.ports.nextIndex('default_pool', pool.length);
      return { ownerId: pool[i]!, groupId: null, reason: 'default_pool' };
    }

    // last resort — a lead is never unassigned, not even for a second
    return { ownerId: await this.ports.getAdminUserId(), groupId: null, reason: 'admin_fallback' };
  }
}
