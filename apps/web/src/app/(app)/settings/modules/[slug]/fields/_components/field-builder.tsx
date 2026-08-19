'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FIELD_TYPES, FIELD_TYPE_SPECS, type FieldType } from '@crm/shared';
import type { FieldDto } from '@/lib/config/fields';
import { api } from '@/lib/client-api';
import { SortableList, SortableRow } from '@/components/config/sortable';
import { FieldCreateOverlay } from './field-create-overlay';
import { FieldEditOverlay } from './field-edit-overlay';
import { messageOf, smallButtonClass, type SectionDto } from './field-form-shared';

/**
 * The drag-and-drop field builder (spec §4.4). Palette on the left is the
 * add affordance — clicking a type opens the create overlay pre-set to it;
 * reordering EXISTING fields is the drag-and-drop part. One component for
 * every module, configured entirely by the slug.
 */

const CREATABLE_TYPES = FIELD_TYPES.filter((t) => !FIELD_TYPE_SPECS[t].isDerived);

type OverlayState =
  | { mode: 'create'; type: FieldType }
  | { mode: 'edit'; field: FieldDto }
  | null;

interface FieldGroup {
  key: string;
  sectionId: string | null;
  label: string;
  active: FieldDto[];
  deleted: FieldDto[];
}

/**
 * The full module-wide active-field order: sections in section order, fields
 * inside each by displayOrder — exactly what POST reorder persists. A field
 * whose section is missing or deleted re-homes to the first section, matching
 * the layout resolver. `moveToEndId` lands a just-moved field at the end of
 * its new section instead of interleaving by its stale displayOrder.
 */
function flatOrder(fields: FieldDto[], sections: SectionDto[], moveToEndId?: string): string[] {
  const orderedSections = [...sections].sort((a, b) => a.displayOrder - b.displayOrder);
  const keys = orderedSections.length ? orderedSections.map((s) => s.id) : ['__none__'];
  const known = new Set(keys);
  const firstKey = keys[0] ?? '__none__';

  const buckets = new Map<string, FieldDto[]>(keys.map((k) => [k, []]));
  for (const f of [...fields].sort((a, b) => a.displayOrder - b.displayOrder)) {
    if (f.isDeleted) continue;
    const key = f.sectionId && known.has(f.sectionId) ? f.sectionId : firstKey;
    buckets.get(key)?.push(f);
  }

  if (moveToEndId) {
    for (const arr of buckets.values()) {
      const i = arr.findIndex((f) => f.id === moveToEndId);
      if (i >= 0) {
        const [moved] = arr.splice(i, 1);
        if (moved) arr.push(moved);
      }
    }
  }

  return [...buckets.values()].flat().map((f) => f.id);
}

export function FieldBuilder({ slug, label }: { slug: string; label: string }) {
  const [sections, setSections] = useState<SectionDto[]>([]);
  const [fields, setFields] = useState<FieldDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [overlay, setOverlay] = useState<OverlayState>(null);

  const refresh = useCallback(async () => {
    const [sectionsRes, fieldsRes] = await Promise.all([
      api<{ sections: SectionDto[] }>(`/api/modules/${slug}/sections`),
      api<{ fields: FieldDto[] }>(`/api/modules/${slug}/fields?includeDeleted=1`),
    ]);
    setSections(sectionsRes.sections);
    setFields(fieldsRes.fields);
  }, [slug]);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    refresh()
      .catch((err: unknown) => setLoadError(messageOf(err)))
      .finally(() => setLoading(false));
  }, [refresh]);

  const orderedSections = useMemo(
    () => [...sections].sort((a, b) => a.displayOrder - b.displayOrder),
    [sections],
  );

  const groups = useMemo<FieldGroup[]>(() => {
    // A section-less module still renders one card so its fields have a home.
    const list: FieldGroup[] = orderedSections.length
      ? orderedSections.map((s) => ({ key: s.id, sectionId: s.id, label: s.label, active: [], deleted: [] }))
      : [{ key: '__none__', sectionId: null, label: 'Fields', active: [], deleted: [] }];
    const byKey = new Map(list.map((g) => [g.key, g]));
    const first = list[0];

    for (const f of [...fields].sort((a, b) => a.displayOrder - b.displayOrder)) {
      // No section — or one deleted since — re-homes to the first section,
      // the same rule the layout resolver applies at render time.
      const home = (f.sectionId ? byKey.get(f.sectionId) : undefined) ?? first;
      if (!home) continue;
      (f.isDeleted ? home.deleted : home.active).push(f);
    }
    return list;
  }, [fields, orderedSections]);

  /** Persist a new order optimistically; on failure the server order stands. */
  const persistOrder = useCallback(
    (orderedIds: string[], rollback: FieldDto[]) => {
      api<{ ok: boolean }>(`/api/modules/${slug}/fields/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orderedIds }),
      }).catch((err: unknown) => {
        setFields(rollback);
        setActionError(messageOf(err));
      });
    },
    [slug],
  );

  function handleReorder(groupKey: string, items: FieldDto[]) {
    const rollback = fields;
    const orderedIds = groups.flatMap((g) => (g.key === groupKey ? items : g.active).map((f) => f.id));
    const index = new Map(orderedIds.map((id, i) => [id, i] as const));
    setFields(fields.map((f) => {
      const i = index.get(f.id);
      return i === undefined ? f : { ...f, displayOrder: i };
    }));
    persistOrder(orderedIds, rollback);
  }

  const handleSaved = useCallback(
    (saved: FieldDto, warning?: string) => {
      setOverlay(null);
      setNotice(warning ?? null);
      setActionError(null);

      const old = fields.find((f) => f.id === saved.id);
      const merged = old
        ? fields.map((f) => (f.id === saved.id ? saved : f))
        : [...fields, saved];

      if (old && (old.sectionId ?? null) !== (saved.sectionId ?? null)) {
        // A section move keeps its old displayOrder, which would interleave
        // oddly with the new section's rows. PATCH landed already; follow with
        // a reorder that appends the field to its new section.
        const orderedIds = flatOrder(merged, orderedSections, saved.id);
        const index = new Map(orderedIds.map((id, i) => [id, i] as const));
        setFields(merged.map((f) => {
          const i = index.get(f.id);
          return i === undefined ? f : { ...f, displayOrder: i };
        }));
        api<{ ok: boolean }>(`/api/modules/${slug}/fields/reorder`, {
          method: 'POST',
          body: JSON.stringify({ orderedIds }),
        }).catch((err: unknown) => {
          // The PATCH stuck but the normalising reorder did not — reload so
          // the screen shows the server's truth rather than a guess.
          setActionError(messageOf(err));
          void refresh();
        });
      } else {
        setFields(merged);
      }
    },
    [fields, orderedSections, slug, refresh],
  );

  const handleDeleted = useCallback((deleted: FieldDto) => {
    setOverlay(null);
    setFields((cur) => cur.map((f) => (f.id === deleted.id ? { ...f, isDeleted: true } : f)));
  }, []);

  async function handleRestore(id: string) {
    setActionError(null);
    try {
      const { field } = await api<{ field: FieldDto }>(
        `/api/modules/${slug}/fields/${id}/restore`,
        { method: 'POST' },
      );
      setFields((cur) => cur.map((f) => (f.id === id ? field : f)));
    } catch (err) {
      setActionError(messageOf(err));
    }
  }

  if (loading) {
    return <p className="mt-6 text-sm text-body">Loading fields…</p>;
  }
  if (loadError) {
    return (
      <p role="alert" className="mt-6 rounded bg-error/10 px-3 py-2 text-sm text-error">
        {loadError}
      </p>
    );
  }

  return (
    <div className="mt-6">
      {notice && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded border border-warning bg-warning/10 px-3 py-2 text-sm text-heading">
          <p>{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notice"
            data-track={`${slug}.fields.notice.dismiss`}
            className="shrink-0 text-xs text-body hover:text-heading"
          >
            Dismiss
          </button>
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-4 rounded bg-error/10 px-3 py-2 text-sm text-error"
        >
          <p>{actionError}</p>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label="Dismiss error"
            data-track={`${slug}.fields.error.dismiss`}
            className="shrink-0 text-xs hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="mb-4 flex justify-end">
        <label className="flex items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
            data-track={`${slug}.fields.showDeleted.toggle`}
          />
          Show deleted fields
        </label>
      </div>

      <div className="flex items-start gap-6">
        <aside className="w-64 shrink-0 rounded border border-border bg-surface">
          <h2 className="border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-body">
            Field palette
          </h2>
          <div className="p-2">
            {CREATABLE_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setOverlay({ mode: 'create', type: t })}
                data-track={`${slug}.fields.palette.add`}
                className="flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-sm text-heading hover:bg-background"
              >
                <span className="truncate" title={FIELD_TYPE_SPECS[t].label}>
                  {FIELD_TYPE_SPECS[t].label}
                </span>
                <span aria-hidden="true" className="shrink-0 text-body">
                  +
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0 flex-1 space-y-4">
          {groups.map((g) => (
            <section key={g.key} className="rounded border border-border bg-surface">
              <header className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="truncate text-sm font-semibold text-heading" title={g.label}>
                  {g.label}
                </h2>
                <span className="shrink-0 text-xs text-body">
                  {g.active.length} field{g.active.length === 1 ? '' : 's'}
                </span>
              </header>
              <div className="p-2">
                {g.active.length === 0 && (
                  <p className="px-3 py-2 text-sm text-body">
                    No fields in this section — add one from the palette.
                  </p>
                )}
                <SortableList
                  items={g.active}
                  getId={(f) => f.id}
                  onReorder={(items) => handleReorder(g.key, items)}
                  renderItem={(f) => (
                    <SortableRow
                      key={f.id}
                      id={f.id}
                      dataTrack={`${slug}.fields.row.reorder`}
                      className="rounded hover:bg-background"
                    >
                      <button
                        type="button"
                        onClick={() => setOverlay({ mode: 'edit', field: f })}
                        data-track={`${slug}.fields.row.open`}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded px-2 py-2 text-left"
                      >
                        <FieldRowSummary field={f} />
                      </button>
                    </SortableRow>
                  )}
                />
                {showDeleted &&
                  g.deleted.map((f) => (
                    <div key={f.id} className="flex items-center gap-2 rounded opacity-70">
                      {/* keeps deleted rows column-aligned with the grip handles */}
                      <span className="w-6 shrink-0" aria-hidden="true" />
                      <div className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2">
                        <FieldRowSummary field={f} />
                        <button
                          type="button"
                          onClick={() => void handleRestore(f.id)}
                          data-track={`${slug}.fields.restore.click`}
                          className={`shrink-0 ${smallButtonClass}`}
                        >
                          Restore
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {overlay?.mode === 'create' && (
        <FieldCreateOverlay
          slug={slug}
          moduleLabel={label}
          initialType={overlay.type}
          sections={orderedSections}
          onClose={() => setOverlay(null)}
          onSaved={handleSaved}
        />
      )}
      {overlay?.mode === 'edit' && (
        <FieldEditOverlay
          slug={slug}
          moduleLabel={label}
          field={overlay.field}
          sections={orderedSections}
          onClose={() => setOverlay(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}

function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'error'; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-pill border px-2 py-0.5 text-xs font-medium ${
        tone === 'error' ? 'border-error text-error' : 'border-border text-body'
      }`}
    >
      {children}
    </span>
  );
}

/** One row's content, shared by live (sortable, clickable) and deleted rows. */
function FieldRowSummary({ field }: { field: FieldDto }) {
  const spec = FIELD_TYPE_SPECS[field.type];
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-sm text-heading" title={field.label}>
        {field.label}
      </span>
      <span className="w-28 shrink-0 truncate text-xs text-body" title={spec.label}>
        {spec.label}
      </span>
      <span className="hidden w-44 shrink-0 truncate font-mono text-xs text-body md:inline" title={field.key}>
        {field.key}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {field.isRequired && <Badge>Required</Badge>}
        {field.isUnique && <Badge>Unique</Badge>}
        {field.isSystem && <Badge>System</Badge>}
        {field.isDeleted && <Badge tone="error">Deleted</Badge>}
      </span>
    </>
  );
}
