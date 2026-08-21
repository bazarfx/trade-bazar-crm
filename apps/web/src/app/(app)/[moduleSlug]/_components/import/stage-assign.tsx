'use client';

import { useEffect, useState } from 'react';
import type { ImportAssignment, SettingValues } from '@crm/shared';
import { api } from '@/lib/client-api';
import { Button, FieldLabel, Select, cn } from '@/components/ui';
import { assignable, useDirectory, userLabel } from '../directory';

/**
 * Stage 5 — Assign.
 *
 * The file says "Assign Owner based on Assignment Rules" and offers a picker
 * of rules. There is no rule BUILDER in this product — assignment is the
 * four-tier engine in `packages/records/src/assignment`, aimed by two
 * Admin-nominated pointers — so this stage shows what those pointers actually
 * are instead of an empty rule list dressed up as a configured one.
 *
 * Two choices, and there can never be a third: invariant 1 says a record is
 * never unassigned, so "leave the owner blank" is not on offer. Either the
 * rules decide (each row routed exactly as a manually created record is, with
 * its own ASSIGNED audit row) or every row goes to one named person.
 *
 * The file's other three toggles — Manual Record Approval, Trigger Automation,
 * Assign Follow-up Tasks — are Zoho features with no engine behind them here.
 * A switch that silently does nothing is worse than an absent one.
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
      <div className="flex flex-col gap-4">
        <h3 className="text-lg font-medium text-heading">Assign</h3>
        <p className="text-sm text-body">
          Records in {labelPlural} do not carry an owner, so there is nothing to assign and no
          routing to choose. Every row still lands with its full audit trail — it simply has no
          owner column for the assignment engine to fill.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-medium text-heading">Assignment Rules</h3>
        <p className="mt-1 text-sm text-body">
          Nothing imported is ever left unassigned. Every row gets an owner as it is created, and
          the assignment is written to that record’s own timeline with the reason it was made.
        </p>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">Who owns the imported records</legend>

        <label
          className={cn(
            'flex cursor-pointer gap-3 rounded-lg border bg-surface px-4 py-3',
            assignment.mode === 'RULES' ? 'border-primary' : 'border-border',
          )}
        >
          <input
            type="radio"
            name="import-assignment"
            checked={assignment.mode === 'RULES'}
            onChange={() => onAssignment({ mode: 'RULES' })}
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
            data-track={`${trackPrefix}.assign.select`}
          />
          <span>
            <span className="block text-sm font-medium text-heading">
              Assign Owner based on Assignment Rules
            </span>
            <span className="mt-1 block text-xs text-body">
              Each row runs through the same engine a record created by hand does — so an imported
              record is routed exactly like one typed into the form.
            </span>
          </span>
        </label>

        <label
          className={cn(
            'flex cursor-pointer gap-3 rounded-lg border bg-surface px-4 py-3',
            assignment.mode === 'OWNER' ? 'border-primary' : 'border-border',
          )}
        >
          <input
            type="radio"
            name="import-assignment"
            checked={assignment.mode === 'OWNER'}
            // Radio semantics need a value the moment it is selected, and the
            // commit schema demands a uuid — so the mode carries the empty
            // choice and Next stays blocked until somebody is picked.
            onChange={() => onAssignment({ mode: 'OWNER', ownerId })}
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
            data-track={`${trackPrefix}.assign.select`}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-heading">
              Assign every imported record to one user
            </span>
            <span className="mt-1 block text-xs text-body">
              The whole file lands with one person, recorded on each record as a manual assignment.
              This needs the Reassign permission; without it the import is refused rather than
              quietly routed by the rules instead.
            </span>

            {assignment.mode === 'OWNER' ? (
              <span className="mt-3 block max-w-md">
                <FieldLabel htmlFor="import-owner" required>
                  Owner
                </FieldLabel>
                <Select
                  id="import-owner"
                  value={ownerId}
                  disabled={directory.loading || candidates.length === 0}
                  onChange={(e) => onAssignment({ mode: 'OWNER', ownerId: e.target.value })}
                  data-track={`${trackPrefix}.assign.owner.select`}
                >
                  <option value="">
                    {directory.loading ? 'Loading people…' : 'Choose a user…'}
                  </option>
                  {candidates.map((user) => (
                    <option key={user.id} value={user.id}>
                      {userLabel(user)}
                    </option>
                  ))}
                </Select>
                {!directory.loading && candidates.length === 0 ? (
                  <span className="mt-1 block text-xs text-body">
                    There is nobody here to choose — either your role cannot see the people in this
                    workspace, or every account is deactivated. A deactivated user keeps the records
                    they own but never receives new ones.
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </label>
      </fieldset>

      <div className="rounded-lg border border-border bg-surface px-4 py-3">
        <h4 className="text-xs font-medium text-heading">What the rules are, right now</h4>

        {rules.state === 'loading' ? (
          <p className="mt-2 text-xs text-body">Reading the routing configuration…</p>
        ) : rules.state === 'hidden' ? (
          <p className="mt-2 text-xs text-body">
            The routing configuration is Admin-only, so it cannot be shown here. What it decides is
            fixed either way: a record goes to the group matching its language, an ARK-stamped
            record to the seniors of that language, then to the default pool, and finally to the
            Admin. There is no tier after that and no record is left without an owner.
          </p>
        ) : (
          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-4 text-xs text-body">
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
          <p className="mt-2 text-xs text-heading">
            Neither pointer is nominated yet, so every row whose language matches no group will land
            with the Admin. That is a working import, not a broken one — but if this file is large,
            nominate the pools on Settings → Assignment first.
          </p>
        ) : null}

        {rules.state === 'ready' ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 px-0"
            onClick={() => window.open('/settings/assignment', '_blank', 'noopener')}
            data-track={`${trackPrefix}.assign.settings.open`}
          >
            Open Settings → Assignment
          </Button>
        ) : null}
      </div>
    </div>
  );
}
