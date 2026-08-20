'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Segmented } from '@/components/config/segmented';
import { Button, Chip, Panel, PanelHeader } from '@/components/ui';
import { api } from '@/lib/client-api';
import { messageOf, TRACK, type MatrixModule, type RuleField } from './wire';

/**
 * The per-module field rules for one role — the SECOND overlay in the stack,
 * opened from a row of the matrix. Stacking is supported by OverlayProvider:
 * Escape closes this one and leaves the matrix editor underneath open.
 *
 * It edits nothing on the server. Applying hands the two id arrays back to the
 * matrix editor, which sends them with the rest of the grid on Save — one
 * gesture, one ConfigChangeLog entry with one before/after diff.
 */

/**
 * Hidden and read-only are stored as two independent arrays, but they are not
 * independent in meaning: a value that never leaves the server cannot also be
 * "editable but not writable". Rendering one three-way choice per field makes
 * that impossible to express by accident — and a field arriving in BOTH arrays
 * from an older save resolves to Hidden, which is the stricter of the two.
 */
const ACCESS = ['VISIBLE', 'READONLY', 'HIDDEN'] as const;
type Access = (typeof ACCESS)[number];

const ACCESS_LABEL: Record<Access, string> = {
  VISIBLE: 'Visible',
  READONLY: 'Read-only',
  HIDDEN: 'Hidden',
};

function initialAccess(field: RuleField, module: MatrixModule): Access {
  if (module.hiddenFieldIds.includes(field.id)) return 'HIDDEN';
  if (module.readonlyFieldIds.includes(field.id)) return 'READONLY';
  return 'VISIBLE';
}

interface FieldRulesOverlayProps {
  module: MatrixModule;
  roleName: string;
  /** The Admin role opens every screen read-only; see the matrix editor. */
  readOnly: boolean;
  onApply: (hiddenFieldIds: string[], readonlyFieldIds: string[]) => void;
  onClose: () => void;
}

export function FieldRulesOverlay({
  module,
  roleName,
  readOnly,
  onApply,
  onClose,
}: FieldRulesOverlayProps) {
  const [fields, setFields] = useState<RuleField[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [access, setAccess] = useState<Record<string, Access>>({});

  /**
   * The rules as they stood when this overlay opened. `module` is a fresh
   * object on every re-render of the editor underneath, so depending on it
   * directly would re-run the fetch and throw away the Admin's in-progress
   * choices the moment anything upstream changed. This overlay mounts fresh
   * each time it opens, so the first value is always the right one.
   */
  const opened = useRef(module);

  const load = useCallback(async () => {
    const module = opened.current;
    try {
      // includeDeleted: a rule may name a soft-deleted field (invariant 4 —
      // the definition survives its deletion). Rebuilding the arrays from
      // only the live fields would silently drop that rule on Apply, so the
      // deleted ones are rendered too and can be cleared deliberately.
      const res = await api<{ fields: RuleField[] }>(
        `/api/modules/${module.slug}/fields?includeDeleted=1`,
      );
      setFields(res.fields);
      const next: Record<string, Access> = {};
      for (const field of res.fields) next[field.id] = initialAccess(field, module);
      setAccess(next);
    } catch (err) {
      setLoadError(messageOf(err));
    }
    // No dependencies: everything it reads is the ref captured on mount.
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const values = Object.values(access);
    return {
      hidden: values.filter((a) => a === 'HIDDEN').length,
      readonly: values.filter((a) => a === 'READONLY').length,
    };
  }, [access]);

  function apply() {
    const hidden: string[] = [];
    const readonly: string[] = [];
    for (const [fieldId, value] of Object.entries(access)) {
      if (value === 'HIDDEN') hidden.push(fieldId);
      else if (value === 'READONLY') readonly.push(fieldId);
    }
    onApply(hidden, readonly);
  }

  return (
    <FullScreenOverlay
      title={`${module.labelPlural} — field rules for "${roleName}"`}
      onClose={onClose}
      trackPrefix={`${TRACK}.matrix.fieldrules`}
    >
      <div className="flex min-h-full flex-col">
        <div className="mx-auto w-full max-w-4xl flex-1 px-8 py-8">
          {/* The one thing an Admin must not misread. Hiding a field here is a
              SERVER-side strip, not a UI trick — spelling that out is the
              difference between a permission and a false sense of one. */}
          <div className="rounded border border-border bg-surface px-4 py-3">
            <p className="text-sm font-medium text-heading">
              Hidden means the value never leaves the server.
            </p>
            <p className="mt-1 text-sm text-body">
              A hidden field is stripped when the record is serialised, so it is absent from every
              API response, export and timeline entry this role can reach — not merely absent from
              the screen. Read-only fields are sent but refused on write.
            </p>
          </div>

          {loadError !== null && (
            <div
              role="alert"
              className="mt-4 rounded border border-error bg-surface px-4 py-3 text-sm text-error"
            >
              {loadError}
            </div>
          )}

          <Panel className="mt-6 overflow-hidden">
            <PanelHeader
              title={`${module.labelPlural} fields`}
              actions={
                <span className="text-xs text-body">
                  {counts.hidden} hidden · {counts.readonly} read-only
                </span>
              }
            />

            {fields === null ? (
              loadError === null ? (
                <p className="px-6 py-6 text-sm text-body">Loading fields…</p>
              ) : null
            ) : fields.length === 0 ? (
              <p className="px-6 py-6 text-sm text-body">
                This module has no fields yet, so there is nothing to restrict.
              </p>
            ) : (
              <ul>
                {fields.map((field) => (
                  <li
                    key={field.id}
                    className="flex items-center justify-between gap-4 border-b border-border px-6 py-3 last:border-0"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        {/* truncate + title: an Admin-authored field label has
                            no length limit and must never wrap a row. */}
                        <span className="truncate text-sm text-heading" title={field.label}>
                          {field.label}
                        </span>
                        {field.isSystem && <Chip>System</Chip>}
                        {field.isDeleted && <Chip tone="warning">Deleted</Chip>}
                      </span>
                      <span className="truncate text-xs text-body" title={field.key}>
                        {field.key}
                      </span>
                    </span>

                    <Segmented
                      label={`Access to ${field.label}`}
                      options={ACCESS}
                      value={access[field.id] ?? 'VISIBLE'}
                      onChange={(value) => setAccess((prev) => ({ ...prev, [field.id]: value }))}
                      renderLabel={(value) => ACCESS_LABEL[value]}
                      disabled={readOnly}
                      dataTrack={`${TRACK}.matrix.fieldrules.access.select`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* Sticky to the scroll port, not the page: a module with 100 fields
            must not bury the only way to apply the change. */}
        <div className="sticky bottom-0 border-t border-border bg-surface">
          <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-8 py-4">
            {readOnly ? (
              <p className="text-sm text-body">
                The Admin role sees every field. These rules are shown for reference only.
              </p>
            ) : (
              <>
                <Button
                  onClick={apply}
                  disabled={fields === null}
                  data-track={`${TRACK}.matrix.fieldrules.apply`}
                >
                  Apply
                </Button>
                <p className="text-sm text-body">
                  Applied to the grid — nothing is written until you save the matrix.
                </p>
              </>
            )}
            <Button
              variant="secondary"
              onClick={onClose}
              className="ml-auto"
              data-track={`${TRACK}.matrix.fieldrules.cancel`}
            >
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
          </div>
        </div>
      </div>
    </FullScreenOverlay>
  );
}
