'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FIELD_TYPES,
  FIELD_TYPE_SPECS,
  type DependencyReport,
  type FieldType,
  type LayoutSpec,
} from '@crm/shared';
import type { FieldDto } from '@/lib/config/fields';
import { Button, Panel, PanelHeader, Popup, PopupFooter, cn } from '@/components/ui';
import { Segmented } from '@/components/config/segmented';
import { api, ApiClientError } from '@/lib/client-api';
import {
  reconcile,
  toSpec,
  type DraftSection,
  type EditorSection,
  type LayoutSource,
} from '@/app/(app)/settings/modules/[slug]/layout/_components/draft';
import { SectionForm } from '@/app/(app)/settings/modules/[slug]/layout/_components/section-form';
import { FieldCreateOverlay } from '@/app/(app)/settings/modules/[slug]/fields/_components/field-create-overlay';

/** Derived types are computed server-side; the palette never offers them. */
const CREATABLE_TYPES = FIELD_TYPES.filter((t) => !FIELD_TYPE_SPECS[t].isDerived);

/**
 * Pointer-first collision detection, lifted from the settings layout editor:
 * `closestCorners` alone cannot land a field in an EMPTY section — the
 * placeholder's small rect loses the corner race to the big section cards
 * around it — so wherever the pointer actually is inside a droppable, that
 * droppable wins. Keyboard drags carry no pointer and fall through unchanged.
 */
const pointerFirstCollisions: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCorners(args);
};

function errMessage(err: unknown): string {
  return err instanceof ApiClientError ? err.message : 'Something went wrong — try again.';
}

export interface FormLayoutEditProps {
  slug: string;
  moduleLabel: string;
  /** anything persisted changed (field, section, published layout) — host refetches its config */
  onChanged: () => void;
  /** leave edit mode; the component must warn (Popup) if the layout draft is unsaved */
  onDone: () => void;
}

interface DeleteAsk {
  field: FieldDto;
  /** non-null once the un-confirmed DELETE came back 409 DEPENDENCIES */
  deps: DependencyReport | null;
  busy: boolean;
  error: string | null;
}

/**
 * The SHARED in-place form editor: the "edit the fields right here" mode a
 * host screen mounts over its own form. Semantics mirror the settings layout
 * editor exactly — two persistence models on one surface, on purpose:
 *
 *  - FIELDS and SECTIONS are real config rows: rename, required, create and
 *    delete hit the server immediately through the audited config routes;
 *  - FIELD PLACEMENT is a draft LayoutSpec held client-side and published as
 *    ONE `PUT /layouts {target:'FORM', roleId:null}` on Save, so an admin can
 *    rearrange the whole form and commit (or abandon) it as a single
 *    change-log entry.
 *
 * The host owns navigation: `onChanged` fires after every persisted change so
 * the host can refetch its resolved config, and `onDone` is only called once
 * an unsaved draft has been guarded by the 511 unsaved-changes Popup.
 */
export function FormLayoutEdit({ slug, moduleLabel, onChanged, onDone }: FormLayoutEditProps) {
  const [fields, setFields] = useState<FieldDto[]>([]);
  const [sections, setSections] = useState<EditorSection[]>([]);
  const [draft, setDraft] = useState<DraftSection[]>([]);
  /** JSON of the spec as last saved (or as loaded) — the dirty baseline. */
  const [baseline, setBaseline] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** e.g. the required-fields cap warning the field create route returns. */
  const [warning, setWarning] = useState<string | null>(null);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createType, setCreateType] = useState<FieldType | null>(null);
  const [sectionForm, setSectionForm] = useState<{ section: EditorSection | null } | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<DeleteAsk | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [activeDrag, setActiveDrag] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api<{ fields: FieldDto[] }>(`/api/modules/${slug}/fields`),
      api<{ sections: EditorSection[] }>(`/api/modules/${slug}/sections`),
      api<{ spec: LayoutSpec | null; source: LayoutSource }>(`/api/modules/${slug}/layouts?target=FORM`),
    ])
      .then(([f, s, l]) => {
        if (cancelled) return;
        setFields(f.fields);
        setSections(s.sections);
        const next = reconcile(f.fields, s.sections, l.spec);
        setDraft(next);
        // the baseline is the RECONCILED spec, not the raw stored one — a
        // stale saved spec must not make a freshly opened editor look dirty
        setBaseline(JSON.stringify(toSpec(next)));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const sectionById = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);
  const specJson = useMemo(() => JSON.stringify(toSpec(draft)), [draft]);
  const dirty = specJson !== baseline;

  /**
   * Fold fresh field/section config into the editor. The draft is rebuilt by
   * reconciling the CURRENT draft spec against the new config, so unsaved
   * placement survives every rename, create and delete. A clean draft stays
   * clean: the baseline moves with it, because the same re-homing happens
   * server-side at read time — there is nothing new to publish.
   */
  function rebuild(nextFields: FieldDto[], nextSections: EditorSection[]) {
    const wasClean = !dirty;
    const next = reconcile(nextFields, nextSections, toSpec(draft));
    setFields(nextFields);
    setSections(nextSections);
    setDraft(next);
    if (wasClean) setBaseline(JSON.stringify(toSpec(next)));
  }

  // ── field mutations (persist immediately, audited server-side) ──────────

  async function renameField(field: FieldDto, label: string): Promise<void> {
    const res = await api<{ field: FieldDto }>(`/api/modules/${slug}/fields/${field.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    });
    rebuild(fields.map((f) => (f.id === res.field.id ? res.field : f)), sections);
    onChanged();
  }

  /** The server is the authority on which fields may flip — a systemColumn
   *  the engine fills itself refuses here and the tile shows the message. */
  async function toggleRequired(field: FieldDto): Promise<void> {
    const res = await api<{ field: FieldDto }>(`/api/modules/${slug}/fields/${field.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isRequired: !field.isRequired }),
    });
    rebuild(fields.map((f) => (f.id === res.field.id ? res.field : f)), sections);
    onChanged();
  }

  /**
   * Two-step delete, same as the field builder: the first call runs
   * un-confirmed, and a 409 DEPENDENCIES answer renders the guardrail report
   * inside the confirm popup so the Admin deletes with eyes open. Soft either
   * way — values on existing records and the timeline survive.
   */
  async function requestDelete(ask: DeleteAsk) {
    const confirmed = ask.deps !== null;
    setDeleteAsk({ ...ask, busy: true, error: null });
    try {
      await api<{ ok: boolean }>(
        `/api/modules/${slug}/fields/${ask.field.id}${confirmed ? '?confirmed=1' : ''}`,
        { method: 'DELETE' },
      );
      rebuild(fields.filter((f) => f.id !== ask.field.id), sections);
      setDeleteAsk(null);
      onChanged();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'DEPENDENCIES' && err.dependencies) {
        setDeleteAsk({ field: ask.field, deps: err.dependencies, busy: false, error: null });
      } else {
        setDeleteAsk({ ...ask, busy: false, error: errMessage(err) });
      }
    }
  }

  function handleFieldCreated(field: FieldDto, createWarning?: string) {
    setCreateType(null);
    setWarning(createWarning ?? null);
    rebuild([...fields, field], sections);
    onChanged();
  }

  // ── section mutations (persist immediately) ─────────────────────────────

  function handleSectionSaved(section: EditorSection) {
    const exists = sections.some((s) => s.id === section.id);
    rebuild(
      fields,
      exists ? sections.map((s) => (s.id === section.id ? section : s)) : [...sections, section],
    );
    setSectionForm(null);
    onChanged();
  }

  async function deleteSection(section: EditorSection) {
    setError(null);
    try {
      await api<{ ok: boolean }>(`/api/modules/${slug}/sections/${section.id}`, {
        method: 'DELETE',
      });
      rebuild(fields, sections.filter((s) => s.id !== section.id));
      onChanged();
    } catch (err) {
      // includes the 422 GUARDRAIL when this is the last section
      setError(errMessage(err));
    }
  }

  // ── drag and drop (fields only — placement is the draft) ────────────────

  const sensors = useSensors(
    // a small activation distance keeps plain clicks (rename, required,
    // colSpan, delete) from being swallowed as zero-pixel drags
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Resolve any draggable/droppable id to its holding section — a field id
   *  to the section that contains it, and an empty section's placeholder
   *  droppable (`empty:<sectionId>`) back to that section. */
  function containerOf(id: string, model: DraftSection[]): string | null {
    if (id.startsWith('empty:')) {
      const sectionId = id.slice('empty:'.length);
      return model.some((d) => d.sectionId === sectionId) ? sectionId : null;
    }
    const holder = model.find((d) => d.fields.some((f) => f.fieldId === id));
    return holder ? holder.sectionId : null;
  }

  function handleDragStart(e: DragStartEvent) {
    setActiveDrag(String(e.active.id));
  }

  /** Cross-section moves happen live, while the pointer is still down — this
   *  is what makes the target section open up under the dragged field. */
  function handleDragOver(e: DragOverEvent) {
    if (!activeDrag || !e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    setDraft((prev) => {
      const from = containerOf(activeId, prev);
      const to = containerOf(overId, prev);
      if (!from || !to || from === to) return prev;
      const fromSec = prev.find((s) => s.sectionId === from);
      const moving = fromSec?.fields.find((f) => f.fieldId === activeId);
      if (!moving) return prev;
      // An EMPTY target section is NOT filled live: doing so unmounts the
      // placeholder droppable under the pointer mid-drag, and dnd-kit's
      // always-on measuring then loops on the changed droppable set until
      // React aborts the render ("maximum update depth" — the measure-loop
      // lesson documented in the settings layout editor). The placeholder
      // stays mounted — and highlighted — for the whole drag, and the move
      // lands once, in handleDragEnd.
      const target = prev.find((s) => s.sectionId === to);
      if (!target || target.fields.length === 0) return prev;
      return prev.map((s) => {
        if (s.sectionId === from) {
          return { ...s, fields: s.fields.filter((f) => f.fieldId !== activeId) };
        }
        if (s.sectionId === to) {
          const next = [...s.fields];
          const overIndex = next.findIndex((f) => f.fieldId === overId);
          next.splice(overIndex >= 0 ? overIndex : next.length, 0, moving);
          return { ...s, fields: next };
        }
        return s;
      });
    });
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    if (!e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);

    // a cross-section move normally lands live in onDragOver, leaving only
    // the within-section reorder here — but a drop on an empty section's
    // placeholder (deferred above) or a keyboard drop can arrive on a foreign
    // container without onDragOver ever moving it, so the cross-section case
    // is handled again rather than silently lost.
    setDraft((prev) => {
      const from = containerOf(activeId, prev);
      const to = containerOf(overId, prev);
      if (!from || !to) return prev;
      if (from !== to) {
        const fromSec = prev.find((s) => s.sectionId === from);
        const moving = fromSec?.fields.find((f) => f.fieldId === activeId);
        if (!moving) return prev;
        return prev.map((s) => {
          if (s.sectionId === from) {
            return { ...s, fields: s.fields.filter((f) => f.fieldId !== activeId) };
          }
          if (s.sectionId === to) {
            const next = [...s.fields];
            const overIndex = next.findIndex((f) => f.fieldId === overId);
            next.splice(overIndex >= 0 ? overIndex : next.length, 0, moving);
            return { ...s, fields: next };
          }
          return s;
        });
      }
      return prev.map((s) => {
        if (s.sectionId !== from) return s;
        const ids = s.fields.map((f) => f.fieldId);
        const a = ids.indexOf(activeId);
        const b = ids.indexOf(overId);
        if (a < 0 || b < 0 || a === b) return s;
        return { ...s, fields: arrayMove(s.fields, a, b) };
      });
    });
  }

  function setColSpan(sectionId: string, fieldId: string, colSpan: number) {
    setDraft((prev) =>
      prev.map((s) =>
        s.sectionId !== sectionId
          ? s
          : { ...s, fields: s.fields.map((f) => (f.fieldId === fieldId ? { ...f, colSpan } : f)) },
      ),
    );
  }

  // ── publish (the draft, as ONE audited layout write) ────────────────────

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api<{ layout: unknown }>(`/api/modules/${slug}/layouts`, {
        method: 'PUT',
        body: JSON.stringify({ target: 'FORM', roleId: null, layout: toSpec(draft) }),
      });
      setBaseline(specJson);
      setPublished(true);
      onChanged();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function done() {
    if (dirty) setLeaving(true);
    else onDone();
  }

  // ── render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 truncate text-sm text-body">
          Drag to arrange, rename in place — placement publishes when you save.
        </p>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-warning">Unsaved layout</span>}
          {!dirty && published && <span className="text-xs text-success">Published</span>}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPaletteOpen((v) => !v)}
            disabled={loading}
            data-track={`${slug}.formedit.addfield.toggle`}
          >
            Add field
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSectionForm({ section: null })}
            disabled={loading}
            data-track={`${slug}.formedit.addsection.click`}
          >
            Add section
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || loading}
            loading={saving}
            data-track={`${slug}.formedit.save.click`}
          >
            {saving ? 'Publishing…' : 'Save'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={done}
            data-track={`${slug}.formedit.done.click`}
          >
            Done
          </Button>
        </div>
      </div>

      {paletteOpen && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface p-3">
          <span className="mr-1 text-xs font-medium text-heading">New field:</span>
          {CREATABLE_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setPaletteOpen(false);
                setCreateType(t);
              }}
              data-track={`${slug}.formedit.addfield.type`}
              className="rounded border border-border bg-background px-2.5 py-1 text-xs text-heading hover:border-primary hover:text-primary"
            >
              {FIELD_TYPE_SPECS[t].label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded bg-[var(--globalcolors-red-10)] px-4 py-3 text-sm text-error">
          {error}
        </p>
      )}
      {warning && (
        <p className="flex items-center gap-2 rounded bg-[var(--globalcolors-orange-10)] px-4 py-2 text-xs text-warning">
          <span className="min-w-0 flex-1">{warning}</span>
          <button
            type="button"
            onClick={() => setWarning(null)}
            aria-label="Dismiss warning"
            data-track={`${slug}.formedit.warning.dismiss`}
            className="shrink-0 text-warning hover:text-heading"
          >
            ✕
          </button>
        </p>
      )}

      {loading ? (
        <p className="text-sm text-body">Loading form…</p>
      ) : draft.length === 0 ? (
        <Panel className="p-6">
          <p className="text-sm text-body">
            No sections yet — add one to start placing fields. Until then, forms render every field
            in plain order.
          </p>
        </Panel>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerFirstCollisions}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          <div className="flex flex-col gap-4">
            {draft.map((ds) => {
              const meta = sectionById.get(ds.sectionId);
              if (!meta) return null;
              const columns = Math.max(1, meta.columns);
              return (
                <Panel key={ds.sectionId} className="min-w-0">
                  <PanelHeader
                    className="px-4 py-3"
                    title={
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="truncate">{meta.label}</span>
                        <span className="shrink-0 text-xs font-normal text-body">
                          {meta.columns}-column grid
                        </span>
                      </span>
                    }
                    actions={
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setSectionForm({ section: meta })}
                          data-track={`${slug}.formedit.section.edit`}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => void deleteSection(meta)}
                          data-track={`${slug}.formedit.section.delete`}
                        >
                          Delete
                        </Button>
                      </>
                    }
                  />
                  <SortableContext
                    items={ds.fields.map((f) => f.fieldId)}
                    strategy={rectSortingStrategy}
                  >
                    {/* The section's REAL grid — the same runtime column count
                        and spans the form renders, so arranging fields here is
                        arranging the form. Runtime values cannot be classes,
                        hence the inline styles. */}
                    <div
                      className="grid gap-3 p-4"
                      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                    >
                      {ds.fields.length === 0 && <EmptyDropZone sectionId={ds.sectionId} />}
                      {ds.fields.map((df) => {
                        const field = fieldById.get(df.fieldId);
                        if (!field) return null;
                        return (
                          <EditTile
                            key={df.fieldId}
                            slug={slug}
                            field={field}
                            colSpan={df.colSpan}
                            columns={columns}
                            onColSpan={(n) => setColSpan(ds.sectionId, df.fieldId, n)}
                            onRename={(label) => renameField(field, label)}
                            onToggleRequired={() => toggleRequired(field)}
                            onDelete={() =>
                              setDeleteAsk({ field, deps: null, busy: false, error: null })
                            }
                          />
                        );
                      })}
                    </div>
                  </SortableContext>
                </Panel>
              );
            })}
          </div>

          <DragOverlay>
            {activeDrag && fieldById.get(activeDrag) && (
              // The ghost is the tile itself at a fixed width — the pointer
              // carries the field being placed, not an abstract chip.
              <div className="w-64 rounded border border-border bg-background px-3 pb-2 pt-1.5 shadow-lg">
                <div className="flex items-center gap-1">
                  <span aria-hidden="true" className="w-6 shrink-0 text-center text-sm text-muted">
                    ⠿
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-heading">
                    {fieldById.get(activeDrag)?.label}
                  </span>
                </div>
                <div className="mt-1 flex h-[34px] items-center rounded border border-border bg-surface px-2">
                  <span className="truncate text-xs text-muted">{fieldById.get(activeDrag)?.key}</span>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {createType && (
        <FieldCreateOverlay
          slug={slug}
          moduleLabel={moduleLabel}
          initialType={createType}
          sections={sections}
          onClose={() => setCreateType(null)}
          onSaved={handleFieldCreated}
        />
      )}

      {sectionForm && (
        <SectionForm
          slug={slug}
          section={sectionForm.section}
          onSaved={handleSectionSaved}
          onClose={() => setSectionForm(null)}
        />
      )}

      {deleteAsk && (
        <Popup
          title={`Delete field — ${deleteAsk.field.label}`}
          width={511}
          open
          onClose={() => (deleteAsk.busy ? undefined : setDeleteAsk(null))}
          trackPrefix={`${slug}.formedit.delete`}
          footer={
            <PopupFooter
              trackPrefix={`${slug}.formedit.delete`}
              cancel={{
                label: 'Cancel',
                onClick: () => setDeleteAsk(null),
                disabled: deleteAsk.busy,
              }}
              next={{
                label: deleteAsk.busy
                  ? 'Deleting…'
                  : deleteAsk.deps
                    ? 'Delete anyway'
                    : 'Delete',
                tone: 'destructive',
                onClick: () => void requestDelete(deleteAsk),
                disabled: deleteAsk.busy,
              }}
            />
          }
        >
          {deleteAsk.deps ? (
            <div className="flex flex-col gap-3 text-sm text-heading">
              <p>This field still feeds saved configuration:</p>
              {deleteAsk.deps.views.length > 0 && (
                <p className="text-xs text-body">
                  Views: {deleteAsk.deps.views.map((v) => v.name).join(', ')}
                </p>
              )}
              {deleteAsk.deps.layouts.length > 0 && (
                <p className="text-xs text-body">
                  Layouts: {deleteAsk.deps.layouts.map((l) => l.target).join(', ')}
                </p>
              )}
              {deleteAsk.deps.imports.length > 0 && (
                <p className="text-xs text-body">
                  Import presets: {deleteAsk.deps.imports.map((i) => i.filename).join(', ')}
                </p>
              )}
              <p>Delete it anyway? The delete is soft — values already on records survive.</p>
            </div>
          ) : (
            <p className="text-sm text-heading">
              Delete &ldquo;{deleteAsk.field.label}&rdquo; from this module? The delete is soft —
              values already on records and the timeline stay readable.
            </p>
          )}
          {deleteAsk.error && (
            <p role="alert" className="rounded bg-[var(--globalcolors-red-10)] px-3 py-2 text-xs text-error">
              {deleteAsk.error}
            </p>
          )}
        </Popup>
      )}

      {/* Same 511 shell as the record form's unsaved-changes guard — leaving
          is the DESTRUCTIVE side: it is the button that throws the draft away. */}
      <Popup
        title="You have not Saved your changes."
        width={511}
        open={leaving}
        onClose={() => setLeaving(false)}
        trackPrefix={`${slug}.formedit.leave`}
        footer={
          <PopupFooter
            trackPrefix={`${slug}.formedit.leave`}
            cancel={{ label: 'Stay Here', onClick: () => setLeaving(false) }}
            next={{ label: 'Yes, Leave Page', tone: 'destructive', onClick: onDone }}
          />
        }
      >
        <p className="text-sm text-heading">
          Your field arrangement has not been published. Leave editing anyway?
        </p>
      </Popup>
    </div>
  );
}

/* ── one field, as it sits on the form ──────────────────────────────────── */

interface EditTileProps {
  slug: string;
  field: FieldDto;
  colSpan: number;
  /** The section's column count — a span can never exceed the grid it sits in. */
  columns: number;
  onColSpan: (n: number) => void;
  /** Persist a new label; throws (ApiClientError) on refusal. */
  onRename: (label: string) => Promise<void>;
  /** Persist the flipped isRequired; throws (ApiClientError) on refusal. */
  onToggleRequired: () => Promise<void>;
  onDelete: () => void;
}

/**
 * A field as it sits on the real form — label row on top, the form's 34px
 * white input bar below — with the edit affordances layered on: grip, inline
 * rename, required toggle, colSpan, delete. Mirrors the settings editor's
 * FieldTile recipe: the tile is a grid item whose `gridColumn` span must live
 * on the same element as dnd-kit's transform, so listeners go on an explicit
 * grip button, keeping every other control clickable.
 */
function EditTile({
  slug,
  field,
  colSpan,
  columns,
  onColSpan,
  onRename,
  onToggleRequired,
  onDelete,
}: EditTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(field.label);
  const [renameBusy, setRenameBusy] = useState(false);
  const [requiredBusy, setRequiredBusy] = useState(false);
  const [tileError, setTileError] = useState<string | null>(null);

  const spans = useMemo(() => Array.from({ length: columns }, (_, i) => i + 1), [columns]);

  function startRename() {
    setValue(field.label);
    setTileError(null);
    setEditing(true);
  }

  async function saveRename() {
    const next = value.trim();
    if (!next || renameBusy) return;
    if (next === field.label) {
      setEditing(false);
      return;
    }
    setRenameBusy(true);
    setTileError(null);
    try {
      await onRename(next);
      setEditing(false);
    } catch (err) {
      setTileError(errMessage(err));
    } finally {
      setRenameBusy(false);
    }
  }

  async function flipRequired() {
    if (requiredBusy) return;
    setRequiredBusy(true);
    setTileError(null);
    try {
      await onToggleRequired();
    } catch (err) {
      // e.g. a column the engine fills itself — the server is the authority
      setTileError(errMessage(err));
    } finally {
      setRequiredBusy(false);
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        gridColumn: `span ${Math.min(colSpan, columns)}`,
      }}
      className={cn(
        'min-w-0 rounded border border-border bg-background px-3 pb-2 pt-1.5',
        isDragging && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Reorder ${field.label}`}
          data-track={`${slug}.formedit.field.drop`}
          className="w-6 shrink-0 cursor-grab px-0 hover:text-heading active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true">⠿</span>
        </Button>
        {editing ? (
          <input
            type="text"
            autoFocus
            value={value}
            disabled={renameBusy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void saveRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
                setTileError(null);
              }
            }}
            maxLength={100}
            aria-label={`Rename ${field.label}`}
            data-track={`${slug}.formedit.rename.input`}
            className="min-w-0 flex-1 rounded border border-primary bg-surface px-2 py-0.5 text-sm text-heading outline-none disabled:opacity-60"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-heading" title={field.label}>
            {field.label}
            {field.isRequired && (
              <span aria-hidden="true" className="ml-0.5 text-error">
                *
              </span>
            )}
          </span>
        )}
        {editing ? (
          <span className="shrink-0 text-xs text-body">{renameBusy ? 'Saving…' : '↵ save · esc'}</span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Rename ${field.label}`}
              title="Rename"
              onClick={startRename}
              data-track={`${slug}.formedit.field.rename`}
              className="w-6 shrink-0 px-0"
            >
              <PencilIcon />
            </Button>
            {!field.isSystem && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete ${field.label}`}
                title="Delete field"
                onClick={onDelete}
                data-track={`${slug}.formedit.field.delete`}
                className="w-6 shrink-0 px-0 hover:text-error"
              >
                <TrashIcon />
              </Button>
            )}
          </>
        )}
      </div>

      {/* the form's 34px white input, faux — this tile IS the form the admin
          is editing, so it reads like the rendered field it stands for */}
      <div className="mt-1 flex h-[34px] min-w-0 items-center rounded border border-border bg-surface px-2">
        <span className="truncate text-xs text-muted" title={field.key}>
          {field.key}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-body">
          <input
            type="checkbox"
            checked={field.isRequired}
            disabled={requiredBusy}
            onChange={() => void flipRequired()}
            data-track={`${slug}.formedit.field.required`}
            className="rounded border-border"
          />
          Required
        </label>
        <Segmented
          label={`Column span for ${field.label}`}
          options={spans}
          value={Math.min(colSpan, columns)}
          onChange={onColSpan}
          dataTrack={`${slug}.formedit.field.colspan`}
        />
      </div>

      {tileError && (
        <p role="alert" className="mt-1 text-xs text-error">
          {tileError}
        </p>
      )}
    </div>
  );
}

/**
 * The drop target an empty section keeps. A plain placeholder is invisible to
 * dnd-kit — nothing inside the section is droppable once its last field
 * leaves — so this registers itself under `empty:<sectionId>`, which
 * containerOf resolves back to the section.
 */
function EmptyDropZone({ sectionId }: { sectionId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `empty:${sectionId}` });

  return (
    <p
      ref={setNodeRef}
      style={{ gridColumn: '1 / -1' }}
      className={cn(
        'rounded border border-dashed border-border px-3 py-6 text-center text-xs text-body',
        isOver && 'border-primary text-primary',
      )}
    >
      Drag fields here
    </p>
  );
}

/* icons — traced on the 24 grid the codebase's other screen icons use */

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10 11v5M14 11v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
