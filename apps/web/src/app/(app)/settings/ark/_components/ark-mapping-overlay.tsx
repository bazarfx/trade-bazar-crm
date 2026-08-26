'use client';

import { useMemo, useState } from 'react';
import {
  ARK_CONCEPTS,
  ARK_REQUIRED_CONCEPTS,
  ARK_TRANSFORMS,
  parseArkMapping,
  type ArkConcept,
  type ArkMapping,
  type ArkTransform,
} from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, FieldError } from '@/components/ui';
import { api } from '@/lib/client-api';
import {
  completedRules,
  hasHalfDoneRule,
  MappingRulesEditor,
  ReferencePayload,
  type DraftRule,
  type MappingTarget,
} from '@/app/(app)/settings/intake/_components/mapping-rules';
import type { ArkSourceRow } from './ark-manager';

/**
 * THE admin-configurable space of the conversion slice.
 *
 * The ARK Terminal webhook has no technical spec today — no field names, no
 * auth, no retry contract — so the payload shape is deliberately NOT in code
 * anywhere. It lives in the source's `fieldMapping`, and this overlay is
 * where the Admin fills it in the day the first real account event lands.
 *
 * What IS fixed is the list of CONCEPTS a rule may point at (spec §7 step 2:
 * account number, name, phone, language, deposit amount, deposit time,
 * referral). A rule maps a dot-path onto a concept, never onto a field key:
 * which FIELD an account number lands in is the engine's business, read from
 * the storage shape; which PATH carries it is the Admin's. The contract is
 * `arkMappingSchema` in `packages/shared` — the same schema the worker parses
 * with, so what this saves is exactly what the pipeline executes.
 */

/** The concepts, said in words. Keyed on the union so a concept added to
 *  `ARK_CONCEPTS` without a label is a type error. */
const CONCEPT_LABEL: Record<ArkConcept, string> = {
  accountNumber: 'Account number',
  name: 'Customer name',
  phone: 'Phone',
  language: 'Language',
  depositAmount: 'Deposit amount',
  depositedAt: 'Deposit time',
  referral: 'Referral',
  externalId: "ARK's own event reference",
};

const TRANSFORM_LABEL: Record<ArkTransform, string> = {
  none: 'As-is',
  trim: 'Trim whitespace',
  phone: 'Normalise phone',
  number: 'Read as number',
  date: 'Read as date',
};

const TARGETS: MappingTarget[] = ARK_CONCEPTS.map((c) => ({ value: c, label: CONCEPT_LABEL[c] }));

export interface ArkMappingOverlayProps {
  source: ArkSourceRow;
  onSaved: () => void;
  onClose: () => void;
}

export function ArkMappingOverlay({ source, onSaved, onClose }: ArkMappingOverlayProps) {
  // Through the ONE canonical reader. Null covers "never configured", "missing
  // a required concept" and "unreadable" alike — the worker sees those
  // identically (a FAILED event with an honest message), so the editor must
  // too. The raw rules are still loaded so a partial mapping is editable.
  const stored = useMemo(() => parseArkMapping(source.mapping), [source.mapping]);
  const rawRules = useMemo(() => {
    const raw = source.mapping as { rules?: unknown } | null | undefined;
    return Array.isArray(raw?.rules) ? (raw.rules as Partial<DraftRule & { concept: string }>[]) : [];
  }, [source.mapping]);

  const [rules, setRules] = useState<DraftRule[]>(() =>
    rawRules.map((r) => ({
      source: typeof r.source === 'string' ? r.source : '',
      target: typeof r.concept === 'string' ? r.concept : '',
      transform: typeof r.transform === 'string' ? r.transform : 'none',
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mappedConcepts = new Set(completedRules(rules).map((r) => r.target));
  const missingRequired = ARK_REQUIRED_CONCEPTS.filter((c) => !mappedConcepts.has(c));
  const duplicated = completedRules(rules).length !== mappedConcepts.size;

  function save() {
    if (hasHalfDoneRule(rules)) {
      setError('Every row needs both a payload path and a concept — remove unfinished rows or complete them.');
      return;
    }
    if (duplicated) {
      setError('Each concept may be mapped once — two paths for one concept would leave the pipeline guessing which to trust.');
      return;
    }

    const mapping: ArkMapping = {
      rules: completedRules(rules).map((r) => ({
        source: r.source,
        // The pickers only ever offered members of the two vocabularies, and
        // the server re-validates against the same schema anyway.
        concept: r.target as ArkConcept,
        transform: r.transform as ArkTransform,
      })),
      // Carried through untouched. This overlay edits RULES; it does not edit
      // the referral-field override, and a save that quietly dropped it would
      // return the worker to guessing that field by name.
      ...(source.mapping !== null &&
      typeof source.mapping === 'object' &&
      typeof (source.mapping as { referralField?: unknown }).referralField === 'string'
        ? { referralField: (source.mapping as { referralField: string }).referralField }
        : {}),
    };

    setBusy(true);
    setError(null);
    api<{ source: unknown }>(`/api/ark-sources/${source.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ mapping }),
    })
      .then(() => {
        setBusy(false);
        onSaved();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : 'The mapping could not be saved.');
      });
  }

  return (
    <FullScreenOverlay
      title={`Payload mapping — ${source.name}`}
      onClose={onClose}
      trackPrefix="settings.ark.mapping"
    >
      <div className="mx-auto max-w-5xl px-8 py-8">
        {/* THE honest note — the space left for ARK, stated plainly. */}
        <div className="rounded-lg border border-warning bg-surface px-5 py-4">
          <p className="text-sm font-medium text-heading">
            ARK is not connected yet — this mapping is deliberately empty space.
          </p>
          <p className="mt-1 text-sm text-body">
            No field name, auth scheme or retry rule has been guessed in code. When the first real
            account event arrives it lands in this source&apos;s Events list as FAILED: open it,
            read its shape (it also appears as the reference payload here), map each concept to
            the path that carries it, then replay the event. The matching, the four outcomes, the
            conversion and the deposit ledger are all real and waiting behind this screen.
          </p>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          <div>
            <MappingRulesEditor
              rules={rules}
              onChange={(next) => {
                setRules(next);
                setError(null);
              }}
              targets={TARGETS}
              targetLabel="Concept"
              targetPlaceholder="Choose a concept…"
              transforms={ARK_TRANSFORMS}
              transformLabel={TRANSFORM_LABEL}
              trackPrefix="settings.ark.mapping"
              intro={
                <>
                  Each rule reads one value out of the payload AS one concept the pipeline
                  understands. The path is dot-separated into the JSON —{' '}
                  <code className="rounded bg-subtle px-1 font-mono">account.number</code>,{' '}
                  <code className="rounded bg-subtle px-1 font-mono">customer.phone</code>. Which
                  field each concept lands in is the engine&apos;s business; which path carries it
                  is yours.
                </>
              }
              emptyText="No rules yet — they get written the day the first account event shows its keys."
            />

            {/* What the pipeline cannot run without, stated as state rather
                than refused: a partial mapping is worth saving on the way to
                a complete one, and the worker reports it honestly. */}
            <div className="mt-6 rounded border border-border bg-background px-4 py-3 text-xs text-body">
              <p className="font-medium text-heading">What the pipeline needs</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  <strong className="font-medium text-heading">{CONCEPT_LABEL.phone}</strong> — the
                  matching key: deals first, then active leads, by normalised phone.
                </li>
                <li>
                  <strong className="font-medium text-heading">{CONCEPT_LABEL.accountNumber}</strong>{' '}
                  — what a sign-up or a conversion writes onto the record.
                </li>
                <li>
                  {CONCEPT_LABEL.name} and {CONCEPT_LABEL.language} verify the match — a phone hit
                  with a conflicting name is processed AND flagged for review. {CONCEPT_LABEL.depositAmount}{' '}
                  and {CONCEPT_LABEL.depositedAt} decide between a sign-up and a conversion.{' '}
                  {CONCEPT_LABEL.referral} is carried onto a new lead.
                </li>
              </ul>
              {missingRequired.length > 0 ? (
                <p className="mt-2 text-warning">
                  Not mapped yet: {missingRequired.map((c) => CONCEPT_LABEL[c]).join(', ')}. Until
                  both are mapped every event fails with that reason and waits to be replayed.
                </p>
              ) : stored !== null || completedRules(rules).length > 0 ? (
                <p className="mt-2 text-success">The required concepts are mapped.</p>
              ) : null}
            </div>

            <FieldError>{error}</FieldError>

            <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
              <Button loading={busy} onClick={save} data-track="settings.ark.source.mapping.save">
                Save mapping
              </Button>
              <Button variant="secondary" onClick={onClose} data-track="settings.ark.mapping.cancel">
                Cancel
              </Button>
            </div>
          </div>

          <ReferencePayload payload={source.lastPayload} />
        </div>
      </div>
    </FullScreenOverlay>
  );
}
