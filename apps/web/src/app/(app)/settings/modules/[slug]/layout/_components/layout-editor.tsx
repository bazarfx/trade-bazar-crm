'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { LAYOUT_TARGETS, type LayoutSpec, type LayoutTargetValue } from '@crm/shared';
import { SortableRow } from '@/components/config/sortable';
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

const COL_SPAN_CHOICES = [1, 2, 3] as const;

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
   *  a section id resolves to itself, a field id to its holding section. */
  function containerOf(id: string, model: DraftSection[]): string | null {
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

    // field: any cross-section move already landed in onDragOver — what is
    // left is the final within-section reorder
    setDraft((prev) => {
      const from = containerOf(activeId, prev);
      const to = containerOf(overId, prev);
      if (!from || !to || from !== to) return prev;
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
    <div className="mx-auto max-w-[1440px] px-8 py-10">
      <h1 className="text-xl font-semibold text-heading">{moduleLabel} — layout</h1>
      <p className="mt-1 text-sm text-body">
        Arrange sections and fields. Section changes apply immediately; field placement publishes
        when you save.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Layout target" className="inline-flex overflow-hidden rounded border border-border">
          {LAYOUT_TARGETS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={target === t}
              onClick={() => setTarget(t)}
              data-track={`${slug}.layout.target.select`}
              className={`px-4 py-1.5 text-sm ${
                target === t ? 'bg-primary text-surface' : 'bg-surface text-heading hover:bg-background'
              }`}
            >
              {t === 'FORM' ? 'Form' : 'Detail'}
            </button>
          ))}
        </div>

        <select
          value={roleId ?? ''}
          onChange={(e) => setRoleId(e.target.value || null)}
          aria-label="Role"
          data-track={`${slug}.layout.role.select`}
          className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-heading outline-none focus:border-primary"
        >
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-3">
          {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
          {!dirty && published && <span className="text-xs text-success">Published</span>}
          <button
            type="button"
            onClick={() => setSectionForm({ section: null })}
            disabled={loading}
            data-track={`${slug}.layout.section.add`}
            className="rounded border border-border px-3 py-1.5 text-sm text-heading hover:bg-background disabled:opacity-60"
          >
            Add section
          </button>
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            disabled={loading}
            data-track={`${slug}.layout.preview.open`}
            className="rounded border border-border px-3 py-1.5 text-sm text-heading hover:bg-background disabled:opacity-60"
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving || loading}
            data-track={`${slug}.layout.save.click`}
            className="rounded bg-primary px-4 py-1.5 text-sm font-medium text-surface disabled:opacity-60"
          >
            {saving ? 'Publishing…' : 'Save'}
          </button>
        </div>
      </div>

      {!loading && roleId !== null && source !== 'role' && (
        <p className="mt-2 text-xs text-body">
          Inheriting the module layout — the first save creates this role&rsquo;s own copy.
        </p>
      )}
      {!loading && roleId === null && source === 'none' && (
        <p className="mt-2 text-xs text-body">No layout saved yet — showing the default field order.</p>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-8 text-sm text-body">Loading layout…</p>
      ) : draft.length === 0 ? (
        <section className="mt-6 rounded border border-border bg-surface p-6">
          <p className="text-sm text-body">
            No sections yet — add one to start placing fields. Until then, forms render every field
            in plain order.
          </p>
        </section>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
            <div className="mt-6 flex flex-col gap-4">
              {draft.map((ds) => {
                const meta = sectionById.get(ds.sectionId);
                if (!meta) return null;
                return (
                  <SortableRow
                    key={ds.sectionId}
                    id={ds.sectionId}
                    dataTrack={`${slug}.layout.section.reorder`}
                  >
                    <div className="min-w-0 flex-1 rounded border border-border bg-surface">
                      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                        <div className="flex min-w-0 items-baseline gap-3">
                          <h2 className="truncate text-sm font-semibold text-heading" title={meta.label}>
                            {meta.label}
                          </h2>
                          <span className="shrink-0 text-xs text-body">
                            {meta.columns}-column grid
                          </span>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <button
                            type="button"
                            onClick={() => setSectionForm({ section: meta })}
                            data-track={`${slug}.layout.section.rename`}
                            className="rounded border border-border px-2 py-1 text-xs text-heading hover:bg-background"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteSection(meta)}
                            data-track={`${slug}.layout.section.delete`}
                            className="rounded border border-border px-2 py-1 text-xs text-error hover:bg-background"
                          >
                            Delete
                          </button>
                        </div>
                      </header>
                      <SortableContext
                        items={ds.fields.map((f) => f.fieldId)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="flex flex-col gap-1 p-3">
                          {ds.fields.length === 0 && (
                            <p className="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-body">
                              Drop fields here
                            </p>
                          )}
                          {ds.fields.map((df) => {
                            const field = fieldById.get(df.fieldId);
                            if (!field) return null;
                            return (
                              <SortableRow
                                key={df.fieldId}
                                id={df.fieldId}
                                dataTrack={`${slug}.layout.field.drop`}
                                className="rounded border border-border bg-background px-2 py-1.5"
                              >
                                <span
                                  className="min-w-0 flex-1 truncate text-sm text-heading"
                                  title={field.label}
                                >
                                  {field.label}
                                </span>
                                <span
                                  className="hidden w-40 truncate text-xs text-body sm:block"
                                  title={field.key}
                                >
                                  {field.key}
                                </span>
                                <div
                                  role="group"
                                  aria-label={`Column span for ${field.label}`}
                                  className="inline-flex shrink-0 overflow-hidden rounded border border-border"
                                >
                                  {COL_SPAN_CHOICES.map((n) => (
                                    <button
                                      key={n}
                                      type="button"
                                      aria-pressed={df.colSpan === n}
                                      onClick={() => setColSpan(ds.sectionId, df.fieldId, n)}
                                      data-track={`${slug}.layout.field.colspan`}
                                      className={`px-2 py-0.5 text-xs ${
                                        df.colSpan === n
                                          ? 'bg-primary text-surface'
                                          : 'bg-surface text-heading hover:bg-background'
                                      }`}
                                    >
                                      {n}
                                    </button>
                                  ))}
                                </div>
                              </SortableRow>
                            );
                          })}
                        </div>
                      </SortableContext>
                    </div>
                  </SortableRow>
                );
              })}
            </div>
          </SortableContext>

          <DragOverlay>
            {activeDrag?.kind === 'field' && fieldById.get(activeDrag.id) && (
              <div className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-heading">
                {fieldById.get(activeDrag.id)?.label}
              </div>
            )}
            {activeDrag?.kind === 'section' && sectionById.get(activeDrag.id) && (
              <div className="rounded border border-border bg-surface px-4 py-3 text-sm font-semibold text-heading">
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
