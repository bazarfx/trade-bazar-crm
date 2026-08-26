'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  FIELD_TYPE_SPECS,
  buildRecordSchema,
  normalisePhone,
  type FieldDef,
  type FieldType,
  type FieldValidation,
} from '@crm/shared';
import type { ResolvedSection } from '@crm/core';
import type { FieldDto } from '@/lib/config/fields';
import type { StatusDto } from '@/lib/config/statuses';
import type { UserListItem } from '@/lib/config/users';
import { api, ApiClientError } from '@/lib/client-api';
import { Popup, PopupFooter } from '@/components/ui';
import { FormLayoutEdit } from './form-layout-edit';
import { useSpecials } from './specials';
import { PageTitle } from '@/components/shell/page-title';
import {
  FieldControl,
  type FormField,
  type PicklistOption,
  type RecordFormValues,
} from './field-control';

/**
 * THE record create/edit form. One screen serves every module and both modes:
 * "Create Lead" and "Edit Invoice" are the same component reading different
 * config rows. Its sections, its grid, its controls and its validation are all
 * generated — there is no per-module form and there never will be.
 *
 * A PAGE, not an overlay, and that is measured rather than chosen: the file's
 * `CRM _ Leads_Create Leads` frame draws the sidebar (256 wide) and the top
 * bar (1184x68) around the form, with the title in the top bar at @286,21 —
 * so the shell stays on screen, exactly as it does for Import. The layout
 * below is measured off that frame: a 1152-wide content wrapper (which the
 * shell's own p-4 produces at 1440), section headers at 16px Semi Bold with a
 * collapse chevron, a full-width rule under each, and a 4-column grid of
 * 273-wide fields at a 12px gap. The actions sit ABOVE the form on the right,
 * with the save state on the left; the file draws no sticky footer and no
 * section navigator, so this has neither.
 *
 * It composes four config reads and nothing else:
 *   fields   → what to render and how to validate it
 *   layout   → which section each field sits in, and the grid it sits in
 *   statuses → the pipeline picker, which is a table, not a picklist
 *   users    → the owner picker
 *
 * Cancelling with unsaved work raises the guard the file draws as
 * `-cANCEL`: a 511x203 pop-up, the same shell as Delete Saved Filter.
 */

/**
 * Physical columns the record engine fills for itself on create: the owner
 * (invariant 1 — nothing is ever unassigned) and the opening status (the
 * module's first live status, in the Admin's own order).
 *
 * Keyed on the COLUMN, exactly as `cell.tsx` keys the status chip and as the
 * engine keys its own fallbacks — never on a field key, a label or a slug. An
 * Admin renaming "Lead Owner" to "Relationship Manager" changes nothing here.
 */
const OWNER_COLUMN = 'ownerId';
const STATUS_COLUMN = 'statusId';

/**
 * Types this form cannot produce a value for, so they are rendered inert and
 * left out of the schema entirely. A required field with no working control
 * would otherwise make the form permanently unsubmittable — and the server
 * still enforces the real contract, so nothing is weakened by leaving them out.
 */
const UNWRITABLE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['FILE', 'IMAGE']);

/**
 * The three footer buttons, measured off `Frame 482710` (400x38 = 132 + 12 +
 * 122 + 12 + 122). They are NOT the `Button` primitive: that one is traced
 * from the Leads header, whose secondary is white with a grey border. This
 * row's middle button is canvas-grey with a PRIMARY border, which the
 * primitive has no variant for, so the recipes are stated here rather than
 * fought through overrides that resolve by stylesheet order.
 */
const FORM_BUTTON_BASE =
  'inline-flex h-[38px] shrink-0 items-center justify-center rounded px-3 text-xs font-normal ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const FORM_BUTTON = {
  // 132x38, #00667a, white label
  primary: `${FORM_BUTTON_BASE} w-[132px] border border-border bg-primary text-surface hover:bg-primary-strong`,
  // 122x38, #f6f8fa fill with a #00667a border — the file's own middle state
  accent: `${FORM_BUTTON_BASE} w-[122px] border border-primary bg-background text-primary hover:bg-surface`,
  // 122x38, white with the standard #e5e7eb border
  neutral: `${FORM_BUTTON_BASE} w-[122px] border border-border bg-surface text-heading hover:bg-background`,
} as const;

/** `Icon / Chevron` 18x18 — `Union` 10x6. Points down when a section is open
 *  and rotates a quarter turn when it is collapsed. */
function ChevronIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`shrink-0 transition-transform ${className}`}
    >
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `charm:circle-tick` 16x16, beside "All changes Saved". Drawn only when
 *  there is genuinely nothing outstanding — see `saveState`. */
function CircleTickIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 12.3l2.4 2.4 4.6-4.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A section with no label — the resolver's implicit catch-all for a module
 *  that has no FormSection rows at all. */
const UNSECTIONED = 'Details';

interface RecordResponse {
  record: Record<string, unknown> & { id: string };
}

/** What the form needs before it can render anything. */
interface FormConfig {
  fields: FieldDto[];
  sections: ResolvedSection[];
  statuses: StatusDto[];
  users: UserListItem[];
  record: (Record<string, unknown> & { id: string }) | null;
}

export interface RecordFormScreenProps {
  slug: string;
  /** `module.label` — SINGULAR, the thing one of these records is. */
  label: string;
  /**
   * Field key → physical column, from `FieldDefinition.systemColumn`.
   *
   * It comes from the server rather than from `GET /fields` because `FieldDto`
   * does not serialise the column, and this form has to know which field IS
   * the status and which IS the owner: the status picker is fed from the
   * `Status` table rather than from FieldOption rows, and both are filled
   * server-side on create so neither may be demanded here. Reading the column
   * is the only way to answer that without naming a field — which CLAUDE.md
   * forbids and which a rename would break.
   */
  systemColumns: Record<string, string | null>;
  /**
   * Fields this form shows but may never write, with the reason a person
   * reads — Closed By on a deal ("permanent credit"), the ledger-derived
   * totals. Decided by the caller from the STORAGE SHAPE, never from a field
   * name: the server strips these columns from every write, and the form's
   * job is to say so rather than offer a control that silently does nothing.
   */
  locked?: readonly LockedField[];
  /** Present ⇒ edit that record. Absent ⇒ create a new one. */
  recordId?: string;
  onClose: () => void;
  onSaved?: (recordId: string) => void;
}

export interface LockedField {
  key: string;
  reason: string;
}

const NO_LOCKS: readonly LockedField[] = [];

export function RecordFormScreen({
  slug,
  label,
  systemColumns,
  locked = NO_LOCKS,
  recordId,
  onClose,
  onSaved,
}: RecordFormScreenProps) {
  const [config, setConfig] = useState<FormConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped whenever Edit Fields persisted something — re-reads the config. */
  const [fetchToken, setFetchToken] = useState(0);
  const [layoutEditing, setLayoutEditing] = useState(false);

  const specials = useSpecials();
  const canEditLayout = specials.has('MANAGE_FIELDS_LAYOUTS');

  useEffect(() => {
    let cancelled = false;
    // Drop the previous answer before re-fetching: an overlay reused for a
    // different record would otherwise show the OLD record's values, editable,
    // until the new read lands.
    setConfig(null);
    setLoadError(null);

    async function load() {
      try {
        const [fieldsRes, layoutRes, statusRes, recordRes] = await Promise.all([
          api<{ fields: FieldDto[] }>(`/api/modules/${slug}/fields`),
          api<{ sections: ResolvedSection[] }>(
            `/api/modules/${slug}/layouts/resolved?target=FORM`,
          ),
          api<{ statuses: StatusDto[] }>(`/api/modules/${slug}/statuses`),
          recordId === undefined
            ? Promise.resolve(null)
            : api<RecordResponse>(`/api/modules/${slug}/records/${recordId}`),
        ]);

        // Users are a second round trip on purpose: a module with no
        // USER_LOOKUP field must not pay for a list it will not draw, and only
        // the field set just fetched can answer whether it has one.
        const needsUsers = fieldsRes.fields.some((f) => f.type === 'USER_LOOKUP');
        const users = needsUsers
          ? // 200 is the route's own cap. A failure here must not blank the
            // whole form: a role that cannot enumerate users can still create
            // a record, because the engine assigns the owner anyway.
            await api<{ users: UserListItem[] }>('/api/users?take=200')
              .then((r) => r.users)
              .catch(() => [])
          : [];

        if (cancelled) return;
        setConfig({
          fields: fieldsRes.fields,
          sections: layoutRes.sections,
          statuses: statusRes.statuses,
          users,
          record: recordRes?.record ?? null,
        });
      } catch (err) {
        if (!cancelled) setLoadError(messageOf(err));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, recordId, fetchToken]);

  const title = `${recordId === undefined ? 'Create' : 'Edit'} ${label}`;

  return (
    <>
      <PageTitle title={layoutEditing ? `Edit ${label} Fields` : title} />
      {layoutEditing ? (
        <FormLayoutEdit
          slug={slug}
          moduleLabel={label}
          onChanged={() => setFetchToken((t) => t + 1)}
          onDone={() => {
            setLayoutEditing(false);
            setFetchToken((t) => t + 1);
          }}
        />
      ) : loadError !== null ? (
        <p role="alert" className="rounded border border-error bg-surface px-3 py-2 text-sm text-error">
          {loadError}
        </p>
      ) : config === null ? (
        <p className="flex h-40 items-center justify-center text-sm text-body">Loading…</p>
      ) : (
        // Keyed on the record so the inner form REMOUNTS when the screen is
        // reused for a different record — `defaultValues` are read once, and a
        // reset() dance would leave dirty state behind.
        <RecordForm
          key={`${config.record?.id ?? 'new'}:${fetchToken}`}
          slug={slug}
          label={label}
          systemColumns={systemColumns}
          locked={locked}
          config={config}
          recordId={recordId}
          canEditLayout={canEditLayout}
          onEditLayout={() => setLayoutEditing(true)}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

// ── the form ──────────────────────────────────────────────────────────────

interface PreparedField {
  field: FormField;
  colSpan: number;
}

interface PreparedSection {
  id: string;
  label: string;
  columns: number;
  fields: PreparedField[];
}

interface Prepared {
  sections: PreparedSection[];
  /** Field definitions the generated schema is built from. */
  defs: FieldDef[];
  /** Keys the payload may carry — exactly the keys in `defs`. */
  writableKeys: string[];
  /** PHONE-typed keys, so the resolver can normalise them the way the engine does. */
  phoneKeys: ReadonlySet<string>;
  defaults: RecordFormValues;
}

interface RecordFormProps {
  slug: string;
  label: string;
  systemColumns: Record<string, string | null>;
  locked: readonly LockedField[];
  config: FormConfig;
  recordId: string | undefined;
  /** MANAGE_FIELDS_LAYOUTS — draws the Edit Fields door on the action band. */
  canEditLayout: boolean;
  onEditLayout: () => void;
  onClose: () => void;
  onSaved: ((recordId: string) => void) | undefined;
}

function RecordForm({
  slug,
  label,
  systemColumns,
  locked,
  config,
  recordId,
  canEditLayout,
  onEditLayout,
  onClose,
  onSaved,
}: RecordFormProps) {
  const router = useRouter();
  const isCreate = recordId === undefined;
  const [formError, setFormError] = useState<string | null>(null);

  const prepared = useMemo(
    () => prepare(config, systemColumns, isCreate, locked),
    [config, systemColumns, isCreate, locked],
  );

  const {
    register,
    control,
    handleSubmit,
    getValues,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<RecordFormValues>({
    // `z.preprocess` runs the SAME normalisation the engine runs before it
    // validates. That is normalisation, not a second validation rule, and
    // without it the form rejects input the server would have accepted:
    //   - an untouched optional email arrives as '' and fails `.email()`;
    //   - a blank number coerces to 0 (`Number('')` is 0), writing a zero
    //     nobody typed;
    //   - "98765 43210" fails the generated E.164 check, which the engine
    //     never sees because it calls `normalisePhone` first (spec §6.6).
    // buildRecordSchema stays the only place a RULE is expressed.
    resolver: zodResolver(
      z.preprocess(normaliserFor(prepared.phoneKeys), buildRecordSchema(prepared.defs)),
    ) as unknown as Resolver<RecordFormValues>,
    defaultValues: prepared.defaults,
  });

  /**
   * Which sections are collapsed. The file draws a chevron on every section
   * header, so they collapse; nothing is collapsed to begin with, because a
   * form that opens with its fields hidden reads as broken.
   */
  const [collapsedIds, setCollapsedIds] = useState<string[]>([]);
  /** The unsaved-changes guard the file draws as `-cANCEL`. */
  const [leaving, setLeaving] = useState(false);
  const toggleSection = (id: string) =>
    setCollapsedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /**
   * The file's "All changes Saved" slot. There is no autosave here, so it
   * reports the truth rather than the reassurance — and the tick is drawn
   * only when the words are actually "saved", never beside "Unsaved changes".
   */
  const saveState = isSubmitting
    ? { label: 'Saving…', done: false }
    : isDirty
      ? { label: 'Unsaved changes', done: false }
      : isCreate
        ? { label: 'Nothing entered yet', done: false }
        : { label: 'All changes Saved', done: true };

  /**
   * `save` writes this record; `copy` always creates a new one — that is what
   * "Save as New" means, in both modes.
   */
  async function submit(values: RecordFormValues, intent: 'save' | 'copy') {
    setFormError(null);

    const editing = !isCreate && intent === 'save';
    // Compared against the RAW form values rather than read off RHF's
    // `dirtyFields`: a checkbox group's dirty flag is an array whose shape
    // depends on RHF internals, and a multi-select that silently failed the
    // `=== true` test would drop the user's edit on save.
    const raw = getValues();
    const payload: Record<string, unknown> = {};
    for (const key of prepared.writableKeys) {
      const value = values[key];
      if (editing) {
        // A PATCH says what CHANGED. Sending every key would re-normalise
        // untouched phone numbers and write a diff into the append-only
        // AuditLog for edits that never happened (invariant 2).
        if (unchanged(raw[key], prepared.defaults[key])) continue;
        // An emptied optional field is an explicit clear; the engine treats a
        // null as "set to null" and an absent key as "leave alone".
        payload[key] = value === undefined ? null : value;
        continue;
      }
      // On create an absent key lets the engine apply the field's configured
      // default, the owner fallback and the opening status.
      if (value !== undefined) payload[key] = value;
    }

    if (editing && Object.keys(payload).length === 0) {
      onClose();
      return;
    }

    try {
      const { record } = await api<RecordResponse>(
        editing
          ? `/api/modules/${slug}/records/${recordId}`
          : `/api/modules/${slug}/records`,
        { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      // ONE of the two, never both. `onSaved` is the caller with an opinion
      // about where a save lands — the route wrapper sends the person to the
      // record they just wrote — and `onClose` is the fallback for a caller
      // that only wants the surface dismissed. Calling both navigates forward
      // and then immediately back, which lands the person where they started
      // and reads as a save that did nothing.
      if (onSaved) onSaved(record.id);
      else onClose();
      // The list is a server component; refreshing it is what makes the new
      // row appear without a full navigation.
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        // code VALIDATION carries a per-field map — put each message on its own
        // input rather than in a banner the user has to translate back.
        if (err.fields) {
          for (const [key, messages] of Object.entries(err.fields)) {
            setError(key, { type: 'server', message: messages[0] ?? 'Invalid value' });
          }
        }
      }
      setFormError(messageOf(err));
    }
  }

  const saveTrack = isCreate ? `${slug}.create.submit` : `${slug}.edit.submit`;
  const cancelTrack = isCreate ? `${slug}.create.cancel` : `${slug}.edit.cancel`;

  return (
    // min-h-full + flex-col: the footer sits at the bottom of a short form and
    <form noValidate onSubmit={handleSubmit((values) => submit(values, 'save'))}>
      {/* THE ACTION BAND — measured, and it sits ABOVE the form, not under
          it. `Frame 482710` @1008,94 is 400x38 (132 + 12 + 122 + 12 + 122),
          right-aligned; the save state is `Frame 482740` @284,105 on the
          left. The file draws no sticky footer and no section navigator, so
          neither is here. */}
      <div className="flex h-[38px] items-center justify-between px-3">
        <span className="flex items-center gap-2 text-[13px] font-medium tracking-[0.4px] text-primary">
          {saveState.label}
          {saveState.done ? <CircleTickIcon /> : null}
        </span>

        <div className="flex shrink-0 items-center gap-3">
          <button
            type="submit"
            disabled={isSubmitting}
            data-track={saveTrack}
            className={FORM_BUTTON.primary}
          >
            {isSubmitting ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleSubmit((values) => submit(values, 'copy'))}
            // Always a create, in both modes — hence the create namespace.
            data-track={`${slug}.create.saveAsNew`}
            className={FORM_BUTTON.accent}
          >
            Save as New
          </button>
          <button
            type="button"
            // Asks only when there is something to lose. A guard on a form
            // nobody touched is a dialog that trains people to dismiss guards.
            onClick={() => (isDirty ? setLeaving(true) : onClose())}
            data-track={cancelTrack}
            className={FORM_BUTTON.neutral}
          >
            Cancel
          </button>
          {/* The door into editing the form ITSELF — drag, rename, add,
              everything. Only for a holder of the layouts special; every
              write it leads to is gated again server-side. */}
          {canEditLayout ? (
            <button
              type="button"
              onClick={onEditLayout}
              data-track={`${slug}.form.editfields.open`}
              className={FORM_BUTTON.neutral}
            >
              Edit Fields
            </button>
          ) : null}
        </div>
      </div>

      {prepared.sections.length === 0 ? (
        <p className="mt-8 text-sm text-body">
          {label} has no fields on its form layout yet, so there is nothing to fill in.
        </p>
      ) : (
        prepared.sections.map((section, index) => {
          const collapsed = collapsedIds.includes(section.id);
          return (
            <section key={section.id} data-section-id={section.id} className="mt-9 first:mt-8">
              {/* `Frame 482707` @284,166 — 1128 wide, SPACE_BETWEEN, with the
                  chevron at its right edge. The number is the RENDERED order,
                  so a section an Admin reorders renumbers itself. */}
              <button
                type="button"
                onClick={() => toggleSection(section.id)}
                aria-expanded={!collapsed}
                data-track={`${slug}.form.section.toggle`}
                className="mx-3 flex w-[calc(100%-1.5rem)] items-center justify-between gap-4 text-left"
              >
                <span className="flex min-w-0 items-baseline gap-1 text-lg font-semibold tracking-[0.4px] text-heading">
                  <span className="shrink-0 tabular-nums">{index + 1}.</span>
                  <span className="min-w-0 truncate" title={section.label}>
                    {section.label}
                  </span>
                </span>
                <ChevronIcon className={collapsed ? '-rotate-90' : ''} />
              </button>

              {/* `Line 1` @272,197 — the full 1152 of the content wrapper, so
                  it runs 12px wider than the field grid on either side. */}
              <div aria-hidden="true" className="mt-3 h-px bg-border" />

              {!collapsed ? (
                <div
                  className="mt-3 grid gap-3 px-3"
                  // The column count is the Admin's, read off the FormSection
                  // row — a runtime value, so it cannot be a class. The file
                  // draws four 273-wide columns at a 12px gap across 1128.
                  // minmax(0,1fr) is what stops a long value widening its
                  // column past its share.
                  style={{ gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))` }}
                >
                  {section.fields.map(({ field, colSpan }) => (
                    <div key={field.key} style={{ gridColumn: `span ${colSpan}` }}>
                      <FieldControl
                        slug={slug}
                        field={field}
                        register={register}
                        control={control}
                        error={errorMessage(errors, field.key)}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })
      )}

      {formError !== null ? (
        <p role="alert" className="mx-3 mt-6 rounded border border-error bg-surface px-3 py-2 text-xs text-error">
          {formError}
        </p>
      ) : null}

      {/* `CRM _ Leads_Create Leads-cANCEL` draws this as a 511x203 `Pop up` —
          the same shell as Delete Saved Filter, which is why it is the Popup
          primitive rather than anything of its own. Leaving is the DESTRUCTIVE
          side here: it is the button that throws the work away. */}
      <Popup
        title="You have not Saved your changes."
        width={511}
        open={leaving}
        onClose={() => setLeaving(false)}
        trackPrefix={`${slug}.form.leave`}
        footer={
          <PopupFooter
            trackPrefix={`${slug}.form.leave`}
            cancel={{ label: 'Stay Here', onClick: () => setLeaving(false) }}
            next={{ label: 'Yes, Leave Page', tone: 'destructive', onClick: onClose }}
          />
        }
      >
        {/* The file reads "…move away from the pager?" — its own typo for
            "page", corrected here rather than shipped to the floor. */}
        <p className="text-sm text-heading">
          Are you sure you want to move away from the page?
        </p>
      </Popup>
    </form>
  );
}

// ── config → form ─────────────────────────────────────────────────────────

/**
 * Turn the four config reads into the sections, the schema and the initial
 * values. Pure, and the ONLY place that decides what a field means — the
 * renderer below it just switches on a type.
 */
function prepare(
  config: FormConfig,
  systemColumns: Record<string, string | null>,
  isCreate: boolean,
  locked: readonly LockedField[],
): Prepared {
  const byKey = new Map(config.fields.map((f) => [f.key, f]));
  const lockReason = new Map(locked.map((l) => [l.key, l.reason]));

  const statusOptions: PicklistOption[] = config.statuses
    .filter((s) => !s.isDeleted)
    .map((s) => ({ value: s.id, label: s.name }));

  const userOptions: PicklistOption[] = config.users
    // A deactivated account may still own historical records but must not be
    // offered as the owner of a new one.
    .filter((u) => u.isActive !== false)
    .map((u) => ({ value: u.id, label: u.fullName ?? u.email ?? u.id }));

  const sections: PreparedSection[] = [];
  const defs: FieldDef[] = [];
  const writableKeys: string[] = [];
  const phoneKeys = new Set<string>();
  const defaults: RecordFormValues = {};

  for (const resolved of config.sections) {
    const columns = Math.max(1, resolved.columns);
    const prepared: PreparedField[] = [];

    for (const ref of resolved.fields) {
      const dto = byKey.get(ref.key);
      // A layout may name a field this actor cannot see — those are stripped
      // server-side before the resolver runs, so this only guards stale config.
      if (!dto || dto.isDeleted) continue;
      // Derived values are computed server-side and are never rendered.
      if (FIELD_TYPE_SPECS[dto.type].isDerived) continue;

      const column = systemColumns[dto.key] ?? null;
      const stored = config.record ? config.record[dto.key] : undefined;

      // The status field is a pointer into the `Status` table, not a picklist:
      // its choices are the module's statuses, which is why it looks empty when
      // read from FieldOption rows.
      const ownOptions =
        column === STATUS_COLUMN
          ? statusOptions
          : dto.type === 'USER_LOOKUP'
            ? userOptions
            : dto.options
                .filter((o) => !o.isDeleted)
                .map((o) => ({ value: o.value, label: o.label }));

      // A value already on the record stays selectable even after its option
      // or status was retired (invariant 4) — otherwise editing any OTHER
      // field on that record becomes impossible.
      const options = withCurrent(ownOptions, stored);

      // Owner and status are filled by the engine when the payload omits them,
      // so demanding them here would be the form inventing a rule the server
      // does not have. Read off the physical column, never the field name.
      const serverFilled =
        isCreate && (column === OWNER_COLUMN || column === STATUS_COLUMN);

      const validation = toValidation(dto.validation);
      const isRequired = dto.isRequired && !serverFilled;

      const field: FormField = {
        key: dto.key,
        label: dto.label,
        type: dto.type,
        helpText: dto.helpText,
        isRequired,
        maxLength: validation?.maxLength ?? null,
        options,
        // RECORD_LINK needs the TARGET module to list anything, and the target
        // is `relatedModuleId` on the FieldDefinition — a column `FieldDto`
        // does not serialise, with no route mapping a module id back to a
        // slug. There is no honest way to resolve it here and inventing a
        // route is out of scope, so the control renders disabled and says so
        // rather than pretending to be a picker.
        linkOptions: null,
        hint: serverFilled
          ? column === OWNER_COLUMN
            ? 'Assigned automatically if you leave this blank.'
            : 'Opens in the first status if you leave this blank.'
          : null,
        locked: lockedDisplay(lockReason.get(dto.key), options, stored),
      };

      prepared.push({
        field,
        // A colSpan wider than its section would silently create a new column
        // track and break the grid for every field after it.
        colSpan: Math.min(Math.max(1, ref.colSpan), columns),
      });

      // A locked field is shown and never registered: it cannot enter the
      // payload, the schema or the dirty check.
      if (isWritable(dto) && field.locked === null) {
        writableKeys.push(dto.key);
        if (dto.type === 'PHONE') phoneKeys.add(dto.key);
        defs.push({
          key: dto.key,
          label: dto.label,
          type: dto.type,
          isRequired,
          validation,
          // The same list the picker offers, so what can be chosen and what
          // validates can never disagree.
          options: options.map((o) => ({ value: o.value })),
        });
      }

      defaults[dto.key] = config.record
        ? toInputValue(dto.type, stored)
        : toInputValue(dto.type, dto.defaultValue);
    }

    // An empty section is a numbered heading with nothing under it.
    if (prepared.length === 0) continue;
    sections.push({
      id: resolved.sectionId === '' ? 'unsectioned' : resolved.sectionId,
      label: resolved.label === '' ? UNSECTIONED : resolved.label,
      columns,
      fields: prepared,
    });
  }

  return { sections, defs, writableKeys, phoneKeys, defaults };
}

/** Can this form produce a value for the field at all? */
function isWritable(dto: FieldDto): boolean {
  if (FIELD_TYPE_SPECS[dto.type].isDerived) return false;
  if (UNWRITABLE_TYPES.has(dto.type)) return false;
  // See `linkOptions` above — no resolvable target, no value.
  if (dto.type === 'RECORD_LINK') return false;
  return true;
}

/**
 * What a LOCKED field shows: the stored value as a person reads it — the
 * option's or user's label when the value is one, the raw value otherwise,
 * a dash when empty — with the caller's reason beside it.
 */
function lockedDisplay(
  reason: string | undefined,
  options: PicklistOption[],
  stored: unknown,
): FormField['locked'] {
  if (reason === undefined) return null;
  const label =
    typeof stored === 'string' ? (options.find((o) => o.value === stored)?.label ?? stored) : null;
  const display =
    label !== null && label !== ''
      ? label
      : typeof stored === 'number' || typeof stored === 'boolean'
        ? String(stored)
        : stored === null || stored === undefined || stored === ''
          ? '—'
          : String(stored);
  return { display, reason };
}

/** Keep a value the record already holds selectable, whatever config says now. */
export function withCurrent(options: PicklistOption[], stored: unknown): PicklistOption[] {
  const values = Array.isArray(stored) ? stored : [stored];
  const missing = values.filter(
    (v): v is string =>
      typeof v === 'string' && v !== '' && !options.some((o) => o.value === v),
  );
  if (missing.length === 0) return options;
  // Labelled with the raw value: the option or status it names is retired, so
  // there is no label left to read — and showing the id beats showing nothing.
  return [...options, ...missing.map((v) => ({ value: v, label: v }))];
}

/**
 * `FieldDefinition.validation` is a Json column, so it arrives as `unknown`
 * and cannot be trusted to hold what this build expects — a row written by an
 * older field builder still has to render.
 */
export function toValidation(raw: unknown): FieldValidation | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: FieldValidation = {};
  for (const key of ['min', 'max', 'minLength', 'maxLength'] as const) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  if (typeof source['regex'] === 'string') out.regex = source['regex'];
  return out;
}

/**
 * A stored value in the shape its control displays.
 *
 * Dates are sliced out of the ISO string in UTC rather than reformatted: the
 * list cells already read UTC for the same reason (a locale format differs
 * between server and client and lands as a hydration mismatch), and the two
 * screens must not disagree about what day a record is dated.
 */
export function toInputValue(type: FieldType, raw: unknown): unknown {
  if (type === 'CHECKBOX' || type === 'TOGGLE') return raw === true;
  if (type === 'MULTI_SELECT' || type === 'LANGUAGE_PICKER') {
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  }
  if (raw === null || raw === undefined) return '';
  if (type === 'DATE' || type === 'DATE_TIME') {
    const iso = typeof raw === 'string' ? raw : String(raw);
    return type === 'DATE' ? iso.slice(0, 10) : iso.slice(0, 16);
  }
  if (typeof raw === 'string') return raw;
  // Numbers arrive as numbers, and a CURRENCY as the exact digits of a
  // Decimal — both go into a text-valued input as a string.
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

/**
 * Did this field survive the edit untouched?
 *
 * Both sides are values in the CONTROL's shape — the same shape `toInputValue`
 * produced — so a Date that zod parsed and a string the input holds are never
 * compared against each other. A checkbox group is compared as a SET: ticking
 * an option off and back on reorders the array without changing what it means,
 * and a diff written for that would be a lie the append-only log keeps forever.
 */
function unchanged(current: unknown, initial: unknown): boolean {
  if (Array.isArray(current) && Array.isArray(initial)) {
    if (current.length !== initial.length) return false;
    const a = current.map(String).sort();
    const b = initial.map(String).sort();
    return a.every((value, i) => value === b[i]);
  }
  return current === initial;
}

/**
 * The payload as the engine would have shaped it before validating: blanks
 * mean ABSENT, and phone values are matched-key normalised. See the resolver
 * comment for why neither of these is validation.
 */
function normaliserFor(phoneKeys: ReadonlySet<string>) {
  return (input: unknown): unknown => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        out[key] = value;
      } else if (value.trim() === '') {
        out[key] = undefined;
      } else {
        // `normalisePhone` is idempotent, so the engine running it again on
        // the way in changes nothing.
        out[key] = phoneKeys.has(key) ? normalisePhone(value) : value;
      }
    }
    return out;
  };
}

/**
 * A record's value bag has no static shape, so its error bag has none either —
 * this narrows one message out without pretending the index is typed.
 */
function errorMessage(errors: FieldErrors<RecordFormValues>, key: string): string | undefined {
  const entry = errors[key] as { message?: unknown } | undefined;
  return typeof entry?.message === 'string' ? entry.message : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
