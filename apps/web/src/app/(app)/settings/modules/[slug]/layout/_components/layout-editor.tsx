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
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LAYOUT_TARGETS, type LayoutSpec, type LayoutTargetValue } from '@crm/shared';
import { SortableRow } from '@/components/config/sortable';
import { Segmented } from '@/components/config/segmented';
import { Button, Panel, PanelHeader, Select, cn } from '@/components/ui';
import { api, ApiClientError } from '@/lib/client-api';
import {
  reconcile,
  toSpec,
  type DraftSection,
  type EditorField,
  type EditorSection,
  type LayoutSource,
  type RoleOption,
} from './draft';
import { SectionForm } from './section-form';
import { LayoutPreview } from './layout-preview';

const COL_SPAN_CHOICES = [1, 2, 3, 4] as const;

/**
 * Pointer-first collision detection. `closestCorners` alone cannot land a
 * field in an EMPTY section: the placeholder's small rect loses the corner
 * race to the big section cards around it, so `over` never becomes the empty
 * zone and the drop is silently lost. Where the pointer actually is inside a
 * droppable, that droppable wins; keyboard drags carry no pointer and fall
 * through to the corner heuristic unchanged.
 */
const pointerFirstCollisions: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCorners(args);
};

function errMessage(err: unknown): string {
  return err instanceof ApiClientError ? err.message : 'Something went wrong — try again.';
}

interface LayoutEditorProps {
  slug: string;
  moduleLabel: string;
}

/**
 * The layout editor (spec §13). Two very different persistence models live on
 * this one screen, on purpose:
 *
 *  - SECTIONS are real config rows — create, rename, delete and reorder hit
 *    the server immediately, each through the config service's audited path;
 *  - FIELD PLACEMENT is a draft LayoutSpec held client-side and published as
 *    one PUT on Save, so an admin can rearrange forty fields and commit (or
 *    abandon) the whole arrangement as a single change-log entry.
 *
 * Drag and drop: SortableList wraps ONE list in its own DndContext, which
 * cannot express dragging a field ACROSS sections — so this editor composes
 * the same SortableRow primitive inside a single multi-container DndContext
 * (section cards sortable in an outer SortableContext, each card's fields in
 * a nested one). Same sensors, same grip handles, same keyboard support.
 */
export function LayoutEditor({ slug, moduleLabel }: LayoutEditorProps) {
  const [target, setTarget] = useState<LayoutTargetValue>('FORM');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleOption[]>([]);

  const [fields, setFields] = useState<EditorField[]>([]);
  const [sections, setSections] = useState<EditorSection[]>([]);
  const [draft, setDraft] = useState<DraftSection[]>([]);
  /** JSON of the spec as last saved (or as loaded) — the dirty baseline. */
  const [baseline, setBaseline] = useState('');
  const [source, setSource] = useState<LayoutSource>('none');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sectionForm, setSectionForm] = useState<{ section: EditorSection | null } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activeDrag, setActiveDrag] = useState<{ kind: 'section' | 'field'; id: string } | null>(null);

  // The role picker loads once — roles do not vary by target. A failure just
  // leaves "All roles" as the only choice rather than blocking the editor.
  useEffect(() => {
    api<{ roles: RoleOption[] }>('/api/roles')
      .then((res) => setRoles(res.roles))
      .catch(() => setRoles([]));
  }, []);

  // Every (target, role) switch reloads and re-reconciles. Fields and sections
  // ride along so the draft is always built against fresh config.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const layoutQuery = `target=${target}${roleId ? `&roleId=${encodeURIComponent(roleId)}` : ''}`;
    Promise.all([
      api<{ fields: EditorField[] }>(`/api/modules/${slug}/fields`),
      api<{ sections: EditorSection[] }>(`/api/modules/${slug}/sections`),
      api<{ spec: LayoutSpec | null; source: LayoutSource }>(`/api/modules/${slug}/layouts?${layoutQuery}`),
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
        setSource(l.source);
        setPublished(false);
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
  }, [slug, target, roleId]);

  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const sectionById = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);
  const specJson = useMemo(() => JSON.stringify(toSpec(draft)), [draft]);
  const dirty = specJson !== baseline;
  const sectionIds = draft.map((d) => d.sectionId);

  // ── section CRUD (persists immediately) ─────────────────────────────────

  /**
   * Fold a fresh section list into the editor. The draft is rebuilt by
   * reconciling the CURRENT draft spec against the new sections, so unsaved
   * field placement survives every section change. A clean draft stays clean:
   * the baseline moves with it, because the same re-homing happens server-side
   * at read time — there is nothing new to publish.
   */
  function rebuildSections(nextSections: EditorSection[]) {
    const wasClean = !dirty;
    const next = reconcile(fields, nextSections, toSpec(draft));
    setSections(nextSections);
    setDraft(next);
    if (wasClean) setBaseline(JSON.stringify(toSpec(next)));
  }

  function handleSectionSaved(section: EditorSection) {
    const exists = sections.some((s) => s.id === section.id);
    rebuildSections(exists ? sections.map((s) => (s.id === section.id ? section : s)) : [...sections, section]);
    setSectionForm(null);
  }

  async function deleteSection(section: EditorSection) {
    setError(null);
    try {
      await api<{ ok: boolean }>(`/api/modules/${slug}/sections/${section.id}`, { method: 'DELETE' });
      rebuildSections(sections.filter((s) => s.id !== section.id));
    } catch (err) {
      // includes the 422 GUARDRAIL when this is the last section
      setError(errMessage(err));
    }
  }

  async function persistSectionOrder(orderedIds: string[]) {
    try {
      const res = await api<{ sections: EditorSection[] }>(`/api/modules/${slug}/sections/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orderedIds }),
      });
      setSections(res.sections);
    } catch (err) {
      setError(errMessage(err));
      // the optimistic order was refused — converge on the server's truth
      try {
        const res = await api<{ sections: EditorSection[] }>(`/api/modules/${slug}/sections`);
        rebuildSections(res.sections);
      } catch {
        /* the error banner above already tells the story */
      }
    }
  }

  // ── drag and drop ────────────────────────────────────────────────────────

  const sensors = useSensors(
    // mirror SortableList: a small activation distance keeps plain clicks
    // (rename, delete, colSpan) from being swallowed as zero-pixel drags
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Resolve any draggable/droppable id to the section that contains it —
   *  a section id resolves to itself, a field id to its holding section, and
   *  an empty section's placeholder droppable (`empty:<sectionId>`) to that
   *  section, so dropping on the placeholder lands in the section. */
  function containerOf(id: string, model: DraftSection[]): string | null {
    if (id.startsWith('empty:')) {
      const sectionId = id.slice('empty:'.length);
      return model.some((d) => d.sectionId === sectionId) ? sectionId : null;
    }
    if (model.some((d) => d.sectionId === id)) return id;
    const holder = model.find((d) => d.fields.some((f) => f.fieldId === id));
    return holder ? holder.sectionId : null;
  }

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    setActiveDrag(draft.some((d) => d.sectionId === id) ? { kind: 'section', id } : { kind: 'field', id });
  }

  /** Cross-section moves happen live, while the pointer is still down — this
   *  is what makes the target section open up under the dragged field. */
  function handleDragOver(e: DragOverEvent) {
    if (activeDrag?.kind !== 'field' || !e.over) return;
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
      // React aborts the render ("maximum update depth"). The placeholder
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
    const drag = activeDrag;
    setActiveDrag(null);
    if (!drag || !e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);

    if (drag.kind === 'section') {
      // a section dropped over a field row lands on that row's card
      const from = sectionIds.indexOf(activeId);
      const to = sectionIds.indexOf(containerOf(overId, draft) ?? overId);
      if (from < 0 || to < 0 || from === to) return;
      const wasClean = !dirty;
      const nextDraft = arrayMove(draft, from, to);
      const orderedIds = nextDraft.map((d) => d.sectionId);
      setDraft(nextDraft);
      setSections((prev) => [...prev].sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id)));
      // reordering sections persists immediately, so a clean draft stays clean
      if (wasClean) setBaseline(JSON.stringify(toSpec(nextDraft)));
      void persistSectionOrder(orderedIds);
      return;
    }

    // field: a cross-section move normally lands live in onDragOver, leaving
    // only the within-section reorder here — but a keyboard drop can arrive
    // on a foreign container without onDragOver ever firing for it, so the
    // cross-section case is handled again rather than silently lost.
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

  // ── save ─────────────────────────────────────────────────────────────────

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api<{ layout: unknown }>(`/api/modules/${slug}/layouts`, {
        method: 'PUT',
        body: JSON.stringify({ target, roleId, layout: toSpec(draft) }),
      });
      setBaseline(specJson);
      // saving under a role forks the inherited module layout into a role row
      setSource(roleId ? 'role' : 'module');
      setPublished(true);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // ── render ───────────────────────────────────────────────────────────────

  return (
    // The shell's <main> owns the canvas gutter; a second page-level one put
    // every settings screen on a different grid from the module list.
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-medium text-heading">{moduleLabel} — layout</h1>
        <p className="mt-1 text-sm text-body">
          Arrange sections and fields. Section changes apply immediately; field placement publishes
          when you save.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Layout target"
          options={LAYOUT_TARGETS}
          value={target}
          onChange={setTarget}
          renderLabel={(t) => (t === 'FORM' ? 'Form' : 'Detail')}
          dataTrack={`${slug}.layout.target.select`}
        />

        <Select
          value={roleId ?? ''}
          onChange={(e) => setRoleId(e.target.value || null)}
          aria-label="Role"
          data-track={`${slug}.layout.role.select`}
          className="w-auto bg-surface"
        >
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>

        <div className="ml-auto flex items-center gap-3">
          {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
          {!dirty && published && <span className="text-xs text-success">Published</span>}
          <Button
            variant="secondary"
            onClick={() => setSectionForm({ section: null })}
            disabled={loading}
            data-track={`${slug}.layout.section.add`}
          >
            Add section
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPreviewOpen(true)}
            disabled={loading}
            data-track={`${slug}.layout.preview.open`}
          >
            Preview
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!dirty || loading}
            loading={saving}
            data-track={`${slug}.layout.save.click`}
          >
            {saving ? 'Publishing…' : 'Save'}
          </Button>
        </div>
      </div>

      {!loading && roleId !== null && source !== 'role' && (
        <p className="-mt-3 text-xs text-body">
          Inheriting the module layout — the first save creates this role&rsquo;s own copy.
        </p>
      )}
      {!loading && roleId === null && source === 'none' && (
        <p className="-mt-3 text-xs text-body">No layout saved yet — showing the default field order.</p>
      )}

      {error && (
        <p role="alert" className="rounded bg-[var(--globalcolors-red-10)] px-4 py-3 text-sm text-error">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-body">Loading layout…</p>
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
          <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-4">
              {draft.map((ds, index) => {
                const meta = sectionById.get(ds.sectionId);
                if (!meta) return null;
                const columns = Math.max(1, meta.columns);
                return (
                  <SortableRow
                    key={ds.sectionId}
                    id={ds.sectionId}
                    dataTrack={`${slug}.layout.section.reorder`}
                  >
                    <Panel className="min-w-0 flex-1">
                      <PanelHeader
                        className="px-4 py-3"
                        title={
                          <span className="flex min-w-0 items-center gap-3">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-border bg-background text-xs font-medium tabular-nums text-heading">
                              {index + 1}
                            </span>
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
                              data-track={`${slug}.layout.section.rename`}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => void deleteSection(meta)}
                              data-track={`${slug}.layout.section.delete`}
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
                        {/* The section's REAL grid — the same runtime column
                            count and spans the form renders, so arranging
                            fields here is arranging the form. Runtime values
                            cannot be classes, hence the inline styles. */}
                        <div
                          className="grid gap-3 p-4"
                          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                        >
                          {ds.fields.length === 0 && <EmptyDropZone sectionId={ds.sectionId} />}
                          {ds.fields.map((df) => {
                            const field = fieldById.get(df.fieldId);
                            if (!field) return null;
                            return (
                              <FieldTile
                                key={df.fieldId}
                                id={df.fieldId}
                                label={field.label}
                                fieldKey={field.key}
                                colSpan={df.colSpan}
                                columns={columns}
                                onColSpan={(n) => setColSpan(ds.sectionId, df.fieldId, n)}
                                gripTrack={`${slug}.layout.field.drop`}
                                colSpanTrack={`${slug}.layout.field.colspan`}
                              />
                            );
                          })}
                        </div>
                      </SortableContext>
                    </Panel>
                  </SortableRow>
                );
              })}
            </div>
          </SortableContext>

          <DragOverlay>
            {activeDrag?.kind === 'field' && fieldById.get(activeDrag.id) && (
              // The ghost is the tile itself at a fixed width — the pointer
              // carries the field being placed, not an abstract chip.
              <div className="w-64 rounded border border-border bg-background px-3 pb-2 pt-1.5 shadow-lg">
                <div className="flex items-center gap-1">
                  <span aria-hidden="true" className="w-6 shrink-0 text-center text-sm text-muted">
                    ⠿
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-heading">
                    {fieldById.get(activeDrag.id)?.label}
                  </span>
                </div>
                <div className="mt-1 flex h-8 items-center rounded border border-border bg-surface px-2">
                  <span className="truncate text-xs text-muted">
                    {fieldById.get(activeDrag.id)?.key}
                  </span>
                </div>
              </div>
            )}
            {activeDrag?.kind === 'section' && sectionById.get(activeDrag.id) && (
              <div className="rounded border border-border bg-surface px-4 py-3 text-sm font-medium text-heading">
                {sectionById.get(activeDrag.id)?.label}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {sectionForm && (
        <SectionForm
          slug={slug}
          section={sectionForm.section}
          onSaved={handleSectionSaved}
          onClose={() => setSectionForm(null)}
        />
      )}

      {previewOpen && (
        <LayoutPreview
          slug={slug}
          moduleLabel={moduleLabel}
          target={target}
          draft={draft}
          fieldById={fieldById}
          sectionById={sectionById}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

interface FieldTileProps {
  id: string;
  label: string;
  fieldKey: string;
  colSpan: number;
  /** The section's column count — a span can never exceed the grid it sits in. */
  columns: number;
  onColSpan: (n: number) => void;
  gripTrack: string;
  colSpanTrack: string;
}

/**
 * A field as it would sit on the form: label row on top, a faux input bar
 * below. SortableRow cannot be used here — the tile is a grid item, and its
 * `gridColumn` span must live on the same element as dnd-kit's transform —
 * so this mirrors SortableRow's pattern directly: listeners/attributes go on
 * an explicit grip button, keeping the Segmented control clickable.
 */
function FieldTile({
  id,
  label,
  fieldKey,
  colSpan,
  columns,
  onColSpan,
  gripTrack,
  colSpanTrack,
}: FieldTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

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
          aria-label="Reorder"
          data-track={gripTrack}
          className="w-6 shrink-0 cursor-grab px-0 hover:text-heading active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true">⠿</span>
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm text-heading" title={label}>
          {label}
        </span>
        <Segmented
          label={`Column span for ${label}`}
          options={COL_SPAN_CHOICES}
          value={colSpan}
          onChange={onColSpan}
          dataTrack={colSpanTrack}
        />
      </div>
      <div className="mt-1 flex h-8 min-w-0 items-center rounded border border-border bg-surface px-2">
        <span className="truncate text-xs text-muted" title={fieldKey}>
          {fieldKey}
        </span>
      </div>
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
