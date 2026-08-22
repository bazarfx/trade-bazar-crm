/**
 * The deal handover rule (spec §7.1): who OWNS a deal the moment it exists.
 *
 * Closed By is the credit; Deal Owner is the work. The Admin nominates where
 * new deals go through `deals.handoverRule` — a specific user, a role (any
 * role; "Back Office" is the spec's example, not a name this file knows), or
 * a round-robin pool — and this function turns that pointer into a person.
 *
 * **Every path returns an owner.** A missing rule, a deleted role, a
 * deactivated user, an empty pool — each degrades to the next tier, and the
 * last tier is the Admin. "Defaults to Admin until configured, so no deal is
 * ever unowned" is spec text; a null from here would be a NOT NULL violation
 * one layer later with nothing to say about why.
 *
 * The rota is the assignment engine's own `advanceRota` over the same
 * `AssignmentState` table, under `handover:` keys — one round-robin
 * implementation in the product, not two that drift.
 */
import type { HandoverDecision } from '@crm/shared';
import { adminUserId, advanceRota } from '../assignment/ports.js';
import { getSetting } from '../config/settings.js';
import type { Tx } from '../config/service.js';

export interface HandoverInput {
  /** the deal's language, carried from the lead; null or empty when unknown */
  language?: string | null;
}

/**
 * The candidates of a tier, narrowed to the ones who speak the language
 * when any do.
 *
 * A PREFERENCE, not a filter: a Hindi customer is better served by a
 * Hindi-speaking back-office user, but a pool with no Hindi speaker still
 * takes the deal rather than pushing it down to the Admin — the spec's tiers
 * are user / role / pool / Admin, and language does not add one. The
 * narrowed list rotates under its own key so the two rotas stay fair
 * independently.
 */
function preferLanguage(
  candidates: { id: string; languages: string[] }[],
  language: string,
): { ids: string[]; keySuffix: string } {
  if (language === '') return { ids: candidates.map((c) => c.id), keySuffix: '' };
  const speakers = candidates.filter((c) => c.languages.includes(language));
  return speakers.length > 0
    ? { ids: speakers.map((c) => c.id), keySuffix: `:lang:${language}` }
    : { ids: candidates.map((c) => c.id), keySuffix: '' };
}

/** Round-robin one tier's candidates, or null when the tier is empty. */
async function rotate(
  tx: Tx,
  key: string,
  candidates: { id: string; languages: string[] }[],
  language: string,
): Promise<string | null> {
  const { ids, keySuffix } = preferLanguage(candidates, language);
  if (ids.length === 0) return null;
  const index = await advanceRota(tx, `${key}${keySuffix}`, ids);
  return ids[index] ?? ids[0] ?? null;
}

/**
 * Resolve the owner of a deal about to be created.
 *
 * Runs on the caller's transaction so the rota advance commits with the deal
 * it was advanced for — a conversion that rolls back must not burn
 * somebody's turn. The settings read is outside it, like the assignment
 * engine's, and cannot throw: an unset or corrupt rule resolves to null and
 * falls through to the Admin.
 *
 * Only ACTIVE users are ever candidates; a deactivated user keeps their
 * history (invariant 4) but never receives new work. Lists are ordered by id
 * so the rota's "one past the last assigned" is stable across calls.
 */
export async function resolveHandoverOwner(tx: Tx, input: HandoverInput = {}): Promise<HandoverDecision> {
  const language = (input.language ?? '').trim();
  const rule = await getSetting('deals.handoverRule');

  if (rule !== null) {
    // Branching on the rule's own discriminator, never on a module or a name:
    // `type` says which table `id` belongs to, and any row there may be nominated.
    switch (rule.type) {
      case 'user': {
        const user = await tx.user.findFirst({
          where: { id: rule.id, isActive: true },
          select: { id: true },
        });
        if (user) return { ownerId: user.id, reason: 'handover_user' };
        break;
      }
      case 'role': {
        const holders = await tx.user.findMany({
          where: { isActive: true, roleId: rule.id, role: { isDeleted: false } },
          orderBy: { id: 'asc' },
          select: { id: true, languages: true },
        });
        const ownerId = await rotate(tx, `handover:role:${rule.id}`, holders, language);
        if (ownerId) return { ownerId, reason: 'handover_role' };
        break;
      }
      case 'pool': {
        const members = await tx.groupMember.findMany({
          where: { groupId: rule.id, group: { isDeleted: false }, user: { isActive: true } },
          orderBy: { userId: 'asc' },
          select: { user: { select: { id: true, languages: true } } },
        });
        const ownerId = await rotate(
          tx,
          `handover:pool:${rule.id}`,
          members.map((m) => m.user),
          language,
        );
        if (ownerId) return { ownerId, reason: 'handover_pool' };
        break;
      }
    }
  }

  // No rule, or a rule pointing at nobody who can work: the Admin. Never null.
  return { ownerId: await adminUserId(tx), reason: 'admin_fallback' };
}
