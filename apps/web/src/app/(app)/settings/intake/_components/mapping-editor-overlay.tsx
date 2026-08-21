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
 * The editor's reference material is `lastPayload` — the newest raw body this
 * source has received — rendered beside the rules so the Admin maps against
 * REAL keys, never remembered ones.
 */

/** The shared transform vocabulary, said in words. Keyed on the union so a
 *  transform added to `INTAKE_TRANSFORMS` without a label is a type error. */
const TRANSFORM_LABEL: Record<IntakeTransform, string> = {
  none: 'As-is',
  trim: 'Trim whitespace',
  phone: 'Normalise phone',
};

/** A rule as the editor holds it — strings all the way, validated on save. */
interface DraftRule {
  source: string;
  target: string;
  transform: IntakeTransform;
}

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

  function patchRule(index: number, patch: Partial<DraftRule>) {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRule(index: number) {
    setRules((prev) => prev.filter((_, i) => i !== index));
  }

  function save() {
    // A half-filled row is a decision the Admin has not finished making;
    // silently dropping it would save a mapping they did not write.
    const kept = rules.filter((r) => r.source.trim() !== '' || r.target !== '');
    const halfDone = kept.some((r) => r.source.trim() === '' || r.target === '');
    if (halfDone) {
      setError('Every row needs both a payload path and a field — remove unfinished rows or complete them.');
      return;
    }

    const mapping: IntakeMapping = {
      rules: kept.map((r) => ({
        source: r.source.trim(),
        target: r.target,
        transform: r.transform,
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

  const hasPayload = source.lastPayload !== null && source.lastPayload !== undefined;

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
            <h3 className="text-sm font-medium text-heading">Field rules</h3>
            <p className="mt-1 text-xs text-body">
              Each rule copies one value out of the payload into one field of{' '}
              {source.moduleLabel}. The path is dot-separated into the JSON —{' '}
              <code className="rounded bg-subtle px-1 font-mono">data.phone</code>,{' '}
              <code className="rounded bg-subtle px-1 font-mono">answers.0.value</code>.
            </p>

            {fieldsError !== null ? <FieldError>{fieldsError}</FieldError> : null}

            <div className="mt-4 flex flex-col gap-3">
              {rules.length === 0 ? (
                <p className="rounded border border-border bg-background px-4 py-3 text-sm text-body">
                  No rules yet — they get written the day the first payload shows its keys.
                </p>
              ) : null}

              {rules.map((rule, index) => (
                // Index keys are safe here: rows reorder only by removal, and
                // a stable id would have to be invented per keystroke.
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <Input
                    value={rule.source}
                    placeholder="payload path, e.g. data.phone"
                    aria-label="Payload path"
                    className="w-56 flex-1 font-mono"
                    onChange={(e) => patchRule(index, { source: e.target.value })}
                    data-track="settings.intake.mapping.rule.source.input"
                  />
                  <span aria-hidden="true" className="text-xs text-body">
                    →
                  </span>
                  <Select
                    value={rule.target}
                    aria-label="Target field"
                    className="w-52"
                    disabled={fieldsLoading}
                    onChange={(e) => patchRule(index, { target: e.target.value })}
                    data-track="settings.intake.mapping.rule.field.select"
                  >
                    <option value="">{fieldsLoading ? 'Loading fields…' : 'Choose a field…'}</option>
                    {fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={rule.transform}
                    aria-label="Transform"
                    className="w-40"
                    onChange={(e) => patchRule(index, { transform: e.target.value as IntakeTransform })}
                    data-track="settings.intake.mapping.rule.transform.select"
                  >
                    {INTAKE_TRANSFORMS.map((t) => (
                      <option key={t} value={t}>
                        {TRANSFORM_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRule(index)}
                    aria-label="Remove this rule"
                    data-track="settings.intake.mapping.rule.remove"
                  >
                    Remove
                  </Button>
                </div>
              ))}

              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setRules((prev) => [...prev, { source: '', target: '', transform: 'none' }])
                  }
                  data-track="settings.intake.mapping.rule.add"
                >
                  Add rule
                </Button>
              </div>
            </div>

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

          {/* ── the reference payload ───────────────────────────────────── */}
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-heading">Reference payload</h3>
            <p className="mt-1 text-xs text-body">
              {hasPayload
                ? 'The newest raw payload this source has received — map against these keys, not remembered ones.'
                : 'Nothing has arrived on this source yet. The first payload — even a failed one — will appear here to map against.'}
            </p>
            {hasPayload ? (
              <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg border border-border bg-background p-4 font-mono text-xs leading-5 text-heading">
                {JSON.stringify(source.lastPayload, null, 2)}
              </pre>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-border bg-background px-4 py-8 text-center text-xs text-body">
                Waiting for the first payload.
              </div>
            )}
          </div>
        </div>
      </div>
    </FullScreenOverlay>
  );
}
