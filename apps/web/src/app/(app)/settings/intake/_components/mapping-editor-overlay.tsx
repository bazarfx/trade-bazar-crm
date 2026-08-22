'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  INTAKE_TRANSFORMS,
  parseIntakeMapping,
  type IntakeMapping,
  type IntakeTransform,
} from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, FieldError, FieldLabel, Input, Select } from '@/components/ui';
import { api } from '@/lib/client-api';
import type { SourceRow } from './intake-manager';
import {
  completedRules,
  hasHalfDoneRule,
  MappingRulesEditor,
  ReferencePayload,
  type DraftRule,
  type MappingTarget,
} from './mapping-rules';

/**
 * THE admin-configurable space at the heart of this slice.
 *
 * Nobody has seen a real Integrately payload — the account does not exist
 * yet — so the payload shape is deliberately NOT in code anywhere. It lives
 * in `WebhookSource.fieldMapping`, and this overlay is where the Admin fills
 * it in the day the first real payload lands. The contract (rule shape,
 * transform vocabulary, dot-path semantics) is `intakeMappingSchema` in
 * `packages/shared` — the same schema the worker parses with, so what this
 * editor saves is exactly what intake executes.
 *
 * The rule rows themselves are `MappingRulesEditor`, shared with the ARK
 * mapping screen; what is specific to INTAKE is here — the targets are the
 * module's live fields, and the campaign link has its own section.
 */

/** The shared transform vocabulary, said in words. Keyed on the union so a
 *  transform added to `INTAKE_TRANSFORMS` without a label is a type error. */
const TRANSFORM_LABEL: Record<IntakeTransform, string> = {
  none: 'As-is',
  trim: 'Trim whitespace',
  phone: 'Normalise phone',
};

interface ModuleField {
  key: string;
  label: string;
  type: string;
  isDeleted: boolean;
}

export interface MappingEditorOverlayProps {
  source: SourceRow;
  onSaved: () => void;
  onClose: () => void;
}

export function MappingEditorOverlay({ source, onSaved, onClose }: MappingEditorOverlayProps) {
  // The stored mapping through the ONE canonical reader. Null covers both
  // "never configured" and "unreadable" — the worker sees those identically,
  // so the editor must too.
  const stored = useMemo(() => parseIntakeMapping(source.mapping), [source.mapping]);
  const storedWasUnreadable =
    stored === null &&
    source.mapping !== null &&
    source.mapping !== undefined &&
    JSON.stringify(source.mapping) !== '{}';

  const [rules, setRules] = useState<DraftRule[]>(() =>
    (stored?.rules ?? []).map((r) => ({ source: r.source, target: r.target, transform: r.transform })),
  );
  const [campaignNameSource, setCampaignNameSource] = useState(stored?.campaignNameSource ?? '');
  const [campaignLinkField, setCampaignLinkField] = useState(stored?.campaignLinkField ?? '');

  const [fields, setFields] = useState<ModuleField[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(true);
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ fields: ModuleField[] }>(`/api/modules/${source.moduleSlug}/fields`)
      .then((res) => {
        if (cancelled) return;
        setFields(res.fields.filter((f) => !f.isDeleted));
        setFieldsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFieldsError(
          err instanceof Error ? err.message : 'The module’s fields could not be loaded.',
        );
        setFieldsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source.moduleSlug]);

  // The campaign link override only makes sense over RECORD_LINK fields; the
  // shared contract auto-detects when the module has exactly one.
  const linkFields = fields.filter((f) => f.type === 'RECORD_LINK');
  const targets: MappingTarget[] = fields.map((f) => ({ value: f.key, label: f.label }));

  function save() {
    if (hasHalfDoneRule(rules)) {
      setError('Every row needs both a payload path and a field — remove unfinished rows or complete them.');
      return;
    }

    const mapping: IntakeMapping = {
      rules: completedRules(rules).map((r) => ({
        source: r.source,
        target: r.target,
        // The editor holds strings; the transform picker only ever offered
        // members of INTAKE_TRANSFORMS, and the server re-validates anyway.
        transform: r.transform as IntakeTransform,
      })),
      ...(campaignNameSource.trim() === '' ? {} : { campaignNameSource: campaignNameSource.trim() }),
      ...(campaignLinkField === '' ? {} : { campaignLinkField }),
    };

    setBusy(true);
    setError(null);
    api<{ source: unknown }>(`/api/webhook-sources/${source.id}`, {
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
      trackPrefix="settings.intake.mapping"
    >
      <div className="mx-auto max-w-5xl px-8 py-8">
        {/* THE honest note. This is the space left for Integrately, stated
            plainly — not a stub pretending the shape is known. */}
        <div className="rounded-lg border border-warning bg-surface px-5 py-4">
          <p className="text-sm font-medium text-heading">
            Integrately is not connected yet — this mapping is deliberately empty space.
          </p>
          <p className="mt-1 text-sm text-body">
            When the first real payload arrives, open the failed event in this source&apos;s
            Events list, read its shape (it also appears as the reference payload below), and
            fill this mapping — then replay the event. No payload shape is guessed in code, so
            nothing breaks when the real one turns out different: an unmapped payload is a failed
            event waiting for this screen, never a lost lead.
          </p>
        </div>

        {storedWasUnreadable ? (
          <p role="alert" className="mt-4 rounded border border-warning bg-surface px-4 py-3 text-xs text-body">
            A stored mapping exists but could not be read (it may predate the current mapping
            format). The intake worker ignores it for the same reason. Saving replaces it.
          </p>
        ) : null}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          {/* ── the rules ─────────────────────────────────────────────── */}
          <div>
            {fieldsError !== null ? <FieldError>{fieldsError}</FieldError> : null}

            <MappingRulesEditor
              rules={rules}
              onChange={setRules}
              targets={targets}
              targetsLoading={fieldsLoading}
              targetLabel="Target field"
              targetPlaceholder="Choose a field…"
              transforms={INTAKE_TRANSFORMS}
              transformLabel={TRANSFORM_LABEL}
              trackPrefix="settings.intake.mapping"
              intro={
                <>
                  Each rule copies one value out of the payload into one field of{' '}
                  {source.moduleLabel}. The path is dot-separated into the JSON —{' '}
                  <code className="rounded bg-subtle px-1 font-mono">data.phone</code>,{' '}
                  <code className="rounded bg-subtle px-1 font-mono">answers.0.value</code>.
                </>
              }
              emptyText="No rules yet — they get written the day the first payload shows its keys."
            />

            {/* ── the campaign link ─────────────────────────────────────── */}
            <div className="mt-8 border-t border-border pt-6">
              <h3 className="text-sm font-medium text-heading">Campaign</h3>
              <p className="mt-1 text-xs text-body">
                Campaign leads link to a Campaign record so performance is comparable
                campaign-by-campaign (spec §6.1). Point this at whatever names the campaign in
                the payload; the intake worker finds or creates that Campaign and links the lead.
              </p>

              <FieldLabel htmlFor="intake-campaign-source" className="mt-4">
                Campaign name path
              </FieldLabel>
              <Input
                id="intake-campaign-source"
                value={campaignNameSource}
                placeholder="e.g. campaign.name — leave empty until the payload shows it"
                className="font-mono"
                onChange={(e) => setCampaignNameSource(e.target.value)}
                data-track="settings.intake.mapping.campaign.input"
              />

              {linkFields.length > 1 ? (
                <>
                  <FieldLabel htmlFor="intake-campaign-field" className="mt-4">
                    Campaign link field
                  </FieldLabel>
                  <Select
                    id="intake-campaign-field"
                    value={campaignLinkField}
                    onChange={(e) => setCampaignLinkField(e.target.value)}
                    data-track="settings.intake.mapping.campaignfield.select"
                  >
                    <option value="">Automatic (single link field)</option>
                    {linkFields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-body">
                    {source.moduleLabel} has {linkFields.length} record-link fields, so say which
                    one carries the campaign.
                  </p>
                </>
              ) : null}
            </div>

            <FieldError>{error}</FieldError>

            <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
              <Button loading={busy} onClick={save} data-track="settings.intake.source.mapping.save">
                Save mapping
              </Button>
              <Button variant="secondary" onClick={onClose} data-track="settings.intake.mapping.cancel">
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
