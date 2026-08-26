'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { ImportAssignment, SettingValues } from '@crm/shared';
import { api } from '@/lib/client-api';
import { cn } from '@/components/ui';
import { ChevronDownIcon } from '../icons';
import { TickIcon } from './icons';
import { assignable, useDirectory, userLabel } from '../directory';

/**
 * Stage 5 — Assign.
 *
 * MEASURED off frames [23] to [27], whose `Pop up` is 1152x516 and whose
 * SECTIONS are the shape of the stage:
 *
 *   `Frame 2121453962`  flex-col gap:12
 *     `Title`   1104x22, Medium 18px `#111827` — "Assignment Rules"
 *     row 28    a 22x22 `tICK` (`bg #00667a`, `r:4`, a white `charm:tick` 14),
 *               gap 12, the label at Regular 14px `#111827`, and a 203x28
 *               select flush right (`#ffffff`, `#e5e7eb`, `r:4`, Regular 10px)
 *   `Separator` 1104x1, then the next section, at the panel's own gap 24
 *
 * That is why this stage has no panel title of its own — its first section
 * heading IS the title, with its control 12px under it and the separator only
 * after both.
 *
 * WHAT IS AND IS NOT BUILT. There is no rule BUILDER in this product —
 * assignment is the four-tier engine in `packages/records/src/assignment`,
 * aimed by two Admin-nominated pointers — so the file's "Choose Assignment
 * Rules" picker has nothing to choose between and is not drawn. The second
 * choice takes the select slot instead, because picking the one owner is a
 * real choice with a real list behind it.
 *
 * Two choices, and there can never be a third: invariant 1 says a record is
 * never unassigned, so "leave the owner blank" is not on offer. Either the
 * rules decide (each row routed exactly as a manually created record is, with
 * its own ASSIGNED audit row) or every row goes to one named person.
 *
 * The file's other three sections — Manual Record Approval, Trigger Automation
 * and process Management, Assign Follow-up Tasks — are Zoho features with no
 * engine behind them here. A switch that silently does nothing is worse than
 * an absent one, so the sections are omitted rather than drawn inert.
 */

export interface StageAssignProps {
  labelPlural: string;
  assignment: ImportAssignment;
  onAssignment: (assignment: ImportAssignment) => void;
  /** this module's rows carry an owner column at all */
  hasOwner: boolean;
  trackPrefix: string;
}

type RulesView =
  | { state: 'loading' }
  /** the routing configuration is Admin-only; an importer who is not one gets
   *  a 403, which is a legitimate answer and not an error to shout about */
  | { state: 'hidden' }
  | { state: 'ready'; seniorRoleName: string | null; hasSeniorRole: boolean; hasPool: boolean };

/** `tICK` / `Checkbox` — 22x22, `r:4`. Unticked is a 20x20 `#ffffff` box with
 *  a `#e5e7eb` stroke; ticked is `#00667a` filled with a white 14px tick. A
 *  real radio underneath, so arrow-key selection and the group name behave
 *  exactly as they did — only the box the file draws is square. */
const CHOICE_BOX =
  'peer h-[22px] w-[22px] shrink-0 appearance-none rounded border border-border bg-surface ' +
  'checked:border-primary checked:bg-primary ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

/** `Frame 2121453966` — 203x28, pad 6/10, value Regular 10px `#6b7280`. */
const RULE_SELECT =
  'h-7 w-[203px] appearance-none rounded border border-border bg-surface pl-[10px] pr-8 ' +
  'text-[10px] text-body focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/** `Title` + its content, at the file's gap 12. Every section in the frame is
 *  this shape, which is why it is one component rather than five copies. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[18px] font-medium leading-[22px] text-heading">{title}</h3>
      {children}
    </div>
  );
}

export function StageAssign({
  labelPlural,
  assignment,
  onAssignment,
  hasOwner,
  trackPrefix,
}: StageAssignProps) {
  const directory = useDirectory(hasOwner);
  const [rules, setRules] = useState<RulesView>({ state: 'loading' });

  useEffect(() => {
    if (!hasOwner) return;
    let cancelled = false;

    async function load(): Promise<void> {
      const res = await api<{ settings: SettingValues }>('/api/settings');
      const seniorRoleId = res.settings['assignment.seniorRoleId'];
      let seniorRoleName: string | null = null;

      // The pointer holds a Role ID — nothing in this product matches a role
      // by name, which is the whole reason the setting exists. Resolving it to
      // a name is a display lookup and is allowed to fail quietly: the same
      // Admin gate guards both reads, so a failure here means the roles list
      // moved, not that the routing is unknown.
      if (seniorRoleId !== null) {
        try {
          const roles = await api<{ roles: { id: string; name: string }[] }>('/api/roles');
          seniorRoleName = roles.roles.find((r) => r.id === seniorRoleId)?.name ?? null;
        } catch {
          seniorRoleName = null;
        }
      }

      if (!cancelled) {
        setRules({
          state: 'ready',
          seniorRoleName,
          hasSeniorRole: seniorRoleId !== null,
          hasPool: res.settings['assignment.defaultPoolGroupId'] !== null,
        });
      }
    }

    load().catch(() => {
      if (!cancelled) setRules({ state: 'hidden' });
    });

    return () => {
      cancelled = true;
    };
  }, [hasOwner]);

  const candidates = assignable(directory.users);
  const ownerId = assignment.mode === 'OWNER' ? assignment.ownerId : '';

  if (!hasOwner) {
    return (
      <Section title="Assignment Rules">
        <p className="text-sm leading-[21px] text-body">
          Records in {labelPlural} do not carry an owner, so there is nothing to assign and no
          routing to choose. Every row still lands with its full audit trail — it simply has no
          owner column for the assignment engine to fill.
        </p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Assignment Rules">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Who owns the imported records</legend>

          {/* `Frame 2121453961` — 28 tall, box then a 12px gap then the label. */}
          <label className="flex cursor-pointer items-center gap-3">
            <span className="relative flex items-center">
              <input
                type="radio"
                name="import-assignment"
                checked={assignment.mode === 'RULES'}
                onChange={() => onAssignment({ mode: 'RULES' })}
                className={CHOICE_BOX}
                data-track={`${trackPrefix}.assign.select`}
              />
              <TickIcon
                aria-hidden="true"
                className="pointer-events-none absolute left-1 hidden h-[14px] w-[14px] text-surface peer-checked:block"
              />
            </span>
            <span className="text-sm leading-[21px] text-heading">
              Assign Owner based on Assignment Rules
            </span>
          </label>

          {/* The select is a SIBLING of the label, not inside it: a control
              nested in a label for another control forwards its clicks to that
              control, which would re-select the radio every time the dropdown
              was opened. */}
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-3">
              <span className="relative flex items-center">
                <input
                  type="radio"
                  name="import-assignment"
                  checked={assignment.mode === 'OWNER'}
                  // Radio semantics need a value the moment it is selected, and
                  // the commit schema demands a uuid — so the mode carries the
                  // empty choice and Next stays blocked until somebody is picked.
                  onChange={() => onAssignment({ mode: 'OWNER', ownerId })}
                  className={CHOICE_BOX}
                  data-track={`${trackPrefix}.assign.select`}
                />
                <TickIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1 hidden h-[14px] w-[14px] text-surface peer-checked:block"
                />
              </span>
              <span className="text-sm leading-[21px] text-heading">
                Assign every imported record to one user
              </span>
            </label>
            {/* The file's 203x28 select, in the slot its "Choose Assignment
                Rules" picker occupies. */}
            <span className="relative shrink-0">
              <select
                aria-label="Owner for every imported record"
                value={ownerId}
                disabled={
                  assignment.mode !== 'OWNER' || directory.loading || candidates.length === 0
                }
                onChange={(e) => onAssignment({ mode: 'OWNER', ownerId: e.target.value })}
                className={RULE_SELECT}
                data-track={`${trackPrefix}.assign.owner.select`}
              >
                <option value="">{directory.loading ? 'Loading people…' : 'Choose a user'}</option>
                {candidates.map((user) => (
                  <option key={user.id} value={user.id}>
                    {userLabel(user)}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-[10px] top-1/2 h-4 w-4 -translate-y-1/2 text-body" />
            </span>
          </div>

          <p className="text-[10px] leading-[15px] text-body">
            {assignment.mode === 'RULES'
              ? 'Each row runs through the same engine a record created by hand does — so an imported record is routed exactly like one typed into the form.'
              : 'The whole file lands with one person, recorded on each record as a manual assignment. This needs the Reassign permission; without it the import is refused rather than quietly routed by the rules instead.'}
          </p>

          {!directory.loading && candidates.length === 0 ? (
            <p className="text-[10px] leading-[15px] text-body">
              There is nobody here to choose — either your role cannot see the people in this
              workspace, or every account is deactivated. A deactivated user keeps the records they
              own but never receives new ones.
            </p>
          ) : null}
        </fieldset>
      </Section>

      {/* `Separator` 1104x1 — the rule between two of the file's sections. */}
      <div className="h-px shrink-0 bg-border" aria-hidden="true" />

      <Section title="What the rules are, right now">
        {rules.state === 'loading' ? (
          <p className="text-sm leading-[21px] text-body">Reading the routing configuration…</p>
        ) : rules.state === 'hidden' ? (
          <p className="text-sm leading-[21px] text-body">
            The routing configuration is Admin-only, so it cannot be shown here. What it decides is
            fixed either way: a record goes to the group matching its language, an ARK-stamped
            record to the seniors of that language, then to the default pool, and finally to the
            Admin. There is no tier after that and no record is left without an owner.
          </p>
        ) : (
          <ol className="flex list-decimal flex-col gap-1 pl-4 text-sm leading-[21px] text-body">
            <li>
              The group whose language matches the record’s, round-robin among its active members.
            </li>
            <li>
              An ARK-stamped record instead goes round-robin among the{' '}
              {rules.hasSeniorRole ? (
                <>
                  holders of <strong>{rules.seniorRoleName ?? 'the nominated senior role'}</strong>
                </>
              ) : (
                <>seniors of that language — but no senior role is nominated, so this tier is skipped</>
              )}
              .
            </li>
            <li>
              {rules.hasPool ? (
                <>
                  The default pool group catches everything the tiers above did not. Its name is on
                  Settings → Assignment.
                </>
              ) : (
                <>No default pool group is nominated, so this tier is skipped.</>
              )}
            </li>
            <li>
              Anything still unclaimed goes to the Admin. That is the floor, not a failure —
              invariant 1 is a NOT NULL column, not an aspiration.
            </li>
          </ol>
        )}

        {rules.state === 'ready' && !rules.hasSeniorRole && !rules.hasPool ? (
          <p className={cn('text-[10px] leading-[15px] text-heading')}>
            Neither pointer is nominated yet, so every row whose language matches no group will land
            with the Admin. That is a working import, not a broken one — but if this file is large,
            nominate the pools on Settings → Assignment first.
          </p>
        ) : null}

        {rules.state === 'ready' ? (
          <button
            type="button"
            onClick={() => window.open('/settings/assignment', '_blank', 'noopener')}
            className="self-start text-[10px] font-medium leading-[15px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            data-track={`${trackPrefix}.assign.settings.open`}
          >
            Open Settings → Assignment
          </button>
        ) : null}
      </Section>
    </div>
  );
}
