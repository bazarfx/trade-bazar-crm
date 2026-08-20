'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SPECIAL_PERMISSIONS,
  SPECIAL_PERMISSION_LABELS,
  VIEW_SCOPES,
  type SpecialPermission,
  type ViewScope,
} from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, Checkbox, Chip, Panel, PanelHeader, Select } from '@/components/ui';
import { api, ApiClientError } from '@/lib/client-api';
import { FieldRulesOverlay } from './field-rules-overlay';
import {
  messageOf,
  SCOPE_HELP,
  SCOPE_LABEL,
  TRACK,
  type MatrixModule,
  type MatrixResponse,
  type RoleRow,
} from './wire';

/**
 * The permission matrix for ONE role (spec §5.1) — full screen, never a modal.
 *
 * Every row is a `ModuleDefinition` returned by the matrix endpoint, including
 * modules this role has no stored row for: absence and an explicit NONE are
 * the same answer to `PermissionEngine.scopeFilter`, so the grid renders the
 * fail-closed default the engine already enforces. Nothing here names a
 * module, so a module created tomorrow appears in every role editor at once.
 *
 * The whole grid saves as one PUT. That is not a convenience: `saveMatrix`
 * snapshots before/after into ConfigChangeLog as one entry, so a one-click
 * undo restores the role exactly as it was rather than half of it.
 */

/**
 * The three flag columns, so the header, the cells and the payload cannot
 * drift apart. `write` is a typed builder rather than a computed key: a
 * computed property whose key is a union of literals widens to an index
 * signature, which would let a typo through the compiler untouched.
 */
interface FlagColumn {
  key: 'canCreate' | 'canEdit' | 'canDelete';
  label: string;
  write: (value: boolean) => Partial<MatrixModule>;
}

const FLAGS: readonly FlagColumn[] = [
  { key: 'canCreate', label: 'Create', write: (canCreate) => ({ canCreate }) },
  { key: 'canEdit', label: 'Edit', write: (canEdit) => ({ canEdit }) },
  { key: 'canDelete', label: 'Delete', write: (canDelete) => ({ canDelete }) },
];

/**
 * A stable string for the whole grid, used only to answer "is this dirty?".
 * Everything with no meaningful order is sorted first — the server returns
 * field-rule ids in whatever order they were stored, and an unsorted compare
 * would report a change the Admin never made.
 */
function fingerprint(modules: MatrixModule[], specials: Set<SpecialPermission>): string {
  const rows = [...modules]
    .sort((a, b) => a.moduleId.localeCompare(b.moduleId))
    .map((m) => [
      m.moduleId,
      m.viewScope,
      m.canCreate,
      m.canEdit,
      m.canDelete,
      [...m.hiddenFieldIds].sort(),
      [...m.readonlyFieldIds].sort(),
    ]);
  return JSON.stringify([rows, [...specials].sort()]);
}

interface MatrixEditorProps {
  role: RoleRow;
  /** Refreshes the list behind this overlay — the counts it shows just moved. */
  onSaved: () => void;
  onClose: () => void;
}

export function MatrixEditor({ role, onSaved, onClose }: MatrixEditorProps) {
  const [modules, setModules] = useState<MatrixModule[] | null>(null);
  const [specials, setSpecials] = useState<Set<SpecialPermission>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** Fingerprint of the last state the server confirmed. */
  const [baseline, setBaseline] = useState<string | null>(null);
  /** The module whose field rules are open in the stacked overlay. */
  const [rulesFor, setRulesFor] = useState<string | null>(null);

  /**
   * Read from the RESPONSE, not from the row that opened this overlay: the
   * list could be stale, and `isLocked` decides whether anything here is
   * writable. `null` is "not answered yet" — `readOnly` below treats it as
   * locked so nothing is writable before the server has said so, while the
   * banner waits for a definite `true` rather than flashing at every role.
   */
  const [locked, setLocked] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<MatrixResponse>(`/api/roles/${role.id}/matrix`);
      const nextSpecials = new Set(res.specials);
      setModules(res.modules);
      setSpecials(nextSpecials);
      setLocked(res.role.isLocked);
      setBaseline(fingerprint(res.modules, nextSpecials));
    } catch (err) {
      setLoadError(messageOf(err));
    }
  }, [role.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (modules === null || baseline === null) return false;
    return fingerprint(modules, specials) !== baseline;
  }, [modules, specials, baseline]);

  /** Any edit invalidates the previous "Saved" line — it described other state. */
  function patchModule(moduleId: string, patch: Partial<MatrixModule>) {
    setSaved(false);
    setModules((prev) =>
      prev === null ? prev : prev.map((m) => (m.moduleId === moduleId ? { ...m, ...patch } : m)),
    );
  }

  function toggleSpecial(permission: SpecialPermission, granted: boolean) {
    setSaved(false);
    setSpecials((prev) => {
      const next = new Set(prev);
      if (granted) next.add(permission);
      else next.delete(permission);
      return next;
    });
  }

  async function save() {
    if (modules === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api<{ ok: true }>(`/api/roles/${role.id}/matrix`, {
        method: 'PUT',
        body: JSON.stringify({
          // The FULL grid every time, including rows parked at NONE: the
          // server writes only what it is sent, and a row omitted here would
          // keep a grant the Admin just removed.
          modules: modules.map((m) => ({
            moduleId: m.moduleId,
            viewScope: m.viewScope,
            canCreate: m.canCreate,
            canEdit: m.canEdit,
            canDelete: m.canDelete,
            hiddenFieldIds: m.hiddenFieldIds,
            readonlyFieldIds: m.readonlyFieldIds,
          })),
          specials: [...specials],
        }),
      });
      setBaseline(fingerprint(modules, specials));
      setSaved(true);
      onSaved();
    } catch (err) {
      // Verbatim, always. A 422 GUARDRAIL message is authored next to the rule
      // it enforces; paraphrasing it here would leave the Admin guessing which
      // rule refused them.
      setSaveError(messageOf(err));
      if (err instanceof ApiClientError && err.status === 404) {
        // The role was deleted underneath this overlay — nothing left to save.
        setModules(null);
      }
    } finally {
      setSaving(false);
    }
  }

  /** Fail closed: unknown reads as locked, so nothing is editable in the gap
   *  between opening the overlay and the matrix arriving. */
  const readOnly = locked !== false;

  const openRules = modules?.find((m) => m.moduleId === rulesFor) ?? null;
  const grantedModules = modules?.filter((m) => m.viewScope !== 'NONE').length ?? 0;

  return (
    <FullScreenOverlay
      title={`Permissions — ${role.name}`}
      onClose={onClose}
      trackPrefix={`${TRACK}.matrix`}
    >
      <div className="flex min-h-full flex-col">
        <div className="mx-auto w-full max-w-6xl flex-1 px-8 py-8">
          {/* Rendered, never hidden. Spec §5.1: Admin is visible in the roles
              screen AND locked. A screen that simply omits the role leaves an
              Admin unable to see what the role they cannot change actually
              grants — and every write path refuses it anyway. */}
          {locked === true && (
            <div
              role="note"
              className="mb-6 rounded border border-info bg-surface px-4 py-3 text-sm"
            >
              <p className="font-medium text-heading">
                This role is locked and opens read-only.
              </p>
              <p className="mt-1 text-body">
                The Admin role holds every permission and cannot be edited, weakened or deleted.
                Removing an Admin&apos;s own reach is how an installation locks itself out with no
                recovery path, so the server refuses the change as well as this screen.
              </p>
            </div>
          )}

          {loadError !== null && (
            <div
              role="alert"
              className="mb-6 rounded border border-error bg-surface px-4 py-3 text-sm text-error"
            >
              {loadError}
            </div>
          )}

          <Panel className="overflow-hidden">
            <PanelHeader
              title="Module access"
              actions={
                <span className="text-xs text-body">
                  {modules === null
                    ? 'Loading…'
                    : `${grantedModules} of ${modules.length} module${modules.length === 1 ? '' : 's'}`}
                </span>
              }
            />

            {modules === null ? (
              loadError === null ? (
                <p className="px-6 py-6 text-sm text-body">Loading the permission matrix…</p>
              ) : null
            ) : modules.length === 0 ? (
              <p className="px-6 py-6 text-sm text-body">
                No modules are enabled yet, so there is nothing to grant.
              </p>
            ) : (
              // A plain table rather than <DataTable>: every cell here is an
              // interactive control, and that primitive truncates its cells
              // into a fixed-height span — right for a record list, wrong for
              // a grid of selects and checkboxes.
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        className="h-11 border-b border-border bg-background px-6 text-xs font-medium text-body"
                      >
                        Module
                      </th>
                      <th
                        scope="col"
                        className="h-11 w-52 border-b border-border bg-background px-3 text-xs font-medium text-body"
                      >
                        View scope
                      </th>
                      {FLAGS.map((flag) => (
                        <th
                          key={flag.key}
                          scope="col"
                          className="h-11 w-24 border-b border-border bg-background px-3 text-center text-xs font-medium text-body"
                        >
                          {flag.label}
                        </th>
                      ))}
                      <th
                        scope="col"
                        className="h-11 w-44 border-b border-border bg-background px-3 text-xs font-medium text-body"
                      >
                        Field rules
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {modules.map((m) => {
                      const restricted = m.hiddenFieldIds.length + m.readonlyFieldIds.length;
                      return (
                        <tr key={m.moduleId} className="border-b border-border last:border-0">
                          <th scope="row" className="max-w-xs px-6 py-3 text-left font-normal">
                            <span className="block truncate text-heading" title={m.labelPlural}>
                              {m.labelPlural}
                            </span>
                            <span className="block truncate text-xs text-body" title={m.slug}>
                              {m.slug}
                            </span>
                          </th>

                          <td className="px-3 py-3">
                            <Select
                              value={m.viewScope}
                              disabled={readOnly}
                              aria-label={`View scope for ${m.labelPlural}`}
                              onChange={(e) =>
                                // The option set IS VIEW_SCOPES, so the value
                                // cannot be anything else; the cast carries no
                                // trust that the server does not re-check.
                                patchModule(m.moduleId, {
                                  viewScope: e.target.value as ViewScope,
                                })
                              }
                              data-track={`${TRACK}.matrix.scope.select`}
                            >
                              {VIEW_SCOPES.map((scope) => (
                                <option key={scope} value={scope}>
                                  {SCOPE_LABEL[scope]}
                                </option>
                              ))}
                            </Select>
                          </td>

                          {FLAGS.map((flag) => (
                            <td key={flag.key} className="px-3 py-3 text-center">
                              <Checkbox
                                checked={m[flag.key]}
                                disabled={readOnly}
                                onChange={(e) =>
                                  patchModule(m.moduleId, flag.write(e.target.checked))
                                }
                                // The visible name is the column header, which
                                // a screen reader does not announce for a bare
                                // checkbox — so each one carries its own.
                                label={
                                  <span className="sr-only">{`${flag.label} in ${m.labelPlural}`}</span>
                                }
                                // The primitive's label sits after an 8px gap
                                // that a visually-hidden label still occupies,
                                // which would leave every box 4px left of its
                                // column. Cancelling the gap re-centres it.
                                className="-mr-2"
                                data-track={`${TRACK}.matrix.flag.toggle`}
                              />
                            </td>
                          ))}

                          <td className="px-3 py-3">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRulesFor(m.moduleId)}
                              data-track={`${TRACK}.matrix.fieldrules.open`}
                              className="px-0 text-primary"
                            >
                              {restricted === 0 ? 'Field rules' : `Field rules (${restricted})`}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* The scope legend, generated from VIEW_SCOPES for the same reason
              the picker is: a sixth scope must never need this list edited. */}
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-body sm:grid-cols-2">
            {VIEW_SCOPES.map((scope) => (
              <div key={scope} className="flex gap-2">
                <dt className="shrink-0 font-medium text-heading">{SCOPE_LABEL[scope]}</dt>
                <dd className="min-w-0">— {SCOPE_HELP[scope]}</dd>
              </div>
            ))}
          </dl>

          <Panel className="mt-6 overflow-hidden">
            <PanelHeader
              title="Special permissions"
              actions={
                <span className="text-xs text-body">
                  {specials.size} of {SPECIAL_PERMISSIONS.length} granted
                </span>
              }
            />
            <div className="px-6 py-5">
              <p className="mb-4 text-sm text-body">
                Granted per role and independent of the grid above: a special permission is a
                capability, not a view — holding one does not widen which records this role can
                see.
              </p>
              {/* Driven by SPECIAL_PERMISSIONS, never a list written here — a
                  permission added to the union appears with no edit to this
                  screen, and one removed cannot linger as a dead checkbox. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {SPECIAL_PERMISSIONS.map((permission) => (
                  <Checkbox
                    key={permission}
                    checked={specials.has(permission)}
                    disabled={readOnly || modules === null}
                    onChange={(e) => toggleSpecial(permission, e.target.checked)}
                    label={SPECIAL_PERMISSION_LABELS[permission]}
                    data-track={`${TRACK}.matrix.special.toggle`}
                  />
                ))}
              </div>
            </div>
          </Panel>
        </div>

        {/* Sticky to the scroll port: with twenty modules the Save button would
            otherwise sit below the fold of a screen the Admin is still reading. */}
        <div className="sticky bottom-0 border-t border-border bg-surface">
          <div className="mx-auto w-full max-w-6xl px-8 py-4">
            {saveError !== null && (
              <div
                role="alert"
                className="mb-3 rounded border border-error bg-surface px-4 py-3 text-sm text-error"
              >
                {saveError}
              </div>
            )}
            <div className="flex items-center gap-3">
              {!readOnly && (
                <Button
                  // Disabled until dirty: a save that writes nothing still
                  // costs a ConfigChangeLog entry, and an empty diff in the
                  // undo stack blocks the revert of the change underneath it.
                  disabled={!dirty}
                  loading={saving}
                  onClick={() => void save()}
                  data-track={`${TRACK}.matrix.save.click`}
                >
                  {saving ? 'Saving…' : 'Save permissions'}
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={onClose}
                data-track={`${TRACK}.matrix.cancel.click`}
              >
                {readOnly ? 'Close' : 'Cancel'}
              </Button>

              {readOnly ? null : dirty ? (
                <p className="text-sm text-body">Unsaved changes.</p>
              ) : saved ? (
                // role="status" so the confirmation is announced, not just
                // painted — the Admin's focus is still on the Save button.
                <p role="status" className="flex items-center gap-2 text-sm text-body">
                  <Chip tone="success">Saved</Chip>
                  All changes saved.
                </p>
              ) : (
                <p className="text-sm text-body">No changes yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The second overlay in the stack. It edits the DRAFT row only — the
          matrix Save is still what writes it. */}
      {openRules !== null && (
        <FieldRulesOverlay
          module={openRules}
          roleName={role.name}
          readOnly={readOnly}
          onClose={() => setRulesFor(null)}
          onApply={(hiddenFieldIds, readonlyFieldIds) => {
            patchModule(openRules.moduleId, { hiddenFieldIds, readonlyFieldIds });
            setRulesFor(null);
          }}
        />
      )}
    </FullScreenOverlay>
  );
}
