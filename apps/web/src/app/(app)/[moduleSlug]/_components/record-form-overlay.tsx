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
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button } from '@/components/ui';
import {
  FieldControl,
  type FormField,
  type PicklistOption,
  type RecordFormValues,
} from './field-control';
import { SectionNav, useActiveSection } from './section-nav';

/**
 * THE record create/edit form. One overlay serves every module and both modes:
 * "Create Lead" and "Edit Invoice" are the same component reading different
 * config rows. Its sections, its grid, its controls and its validation are all
 * generated — there is no per-module form and there never will be.
 *
 * It composes four config reads and nothing else:
 *   fields   → what to render and how to validate it
 *   layout   → which section each field sits in, and the grid it sits in
 *   statuses → the pipeline picker, which is a table, not a picklist
 *   users    → the owner picker
 *
 * Full screen, never a modal card (CLAUDE.md, UI rules).
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

export interface RecordFormOverlayProps {
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
  /** Present ⇒ edit that record. Absent ⇒ create a new one. */
  recordId?: string;
  onClose: () => void;
  onSaved?: (recordId: string) => void;
}

export function RecordFormOverlay({
  slug,
  label,
  systemColumns,
  recordId,
  onClose,
  onSaved,
}: RecordFormOverlayProps) {
  const [config, setConfig] = useState<FormConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
  }, [slug, recordId]);

  const title = `${recordId === undefined ? 'Create' : 'Edit'} ${label}`;

  return (
    <FullScreenOverlay title={title} onClose={onClose} trackPrefix={`${slug}.form`}>
      {loadError !== null ? (
        <div className="mx-auto max-w-2xl px-6 py-12">
          <p role="alert" className="rounded bg-error/10 px-3 py-2 text-sm text-error">
            {loadError}
          </p>
        </div>
      ) : config === null ? (
        <p className="flex h-40 items-center justify-center text-sm text-body">Loading…</p>
      ) : (
        // Keyed on the record so the inner form REMOUNTS when the overlay is
        // reused for a different record — `defaultValues` are read once, and a
        // reset() dance would leave dirty state behind.
        <RecordForm
          key={config.record?.id ?? 'new'}
          slug={slug}
          label={label}
          systemColumns={systemColumns}
          config={config}
          recordId={recordId}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </FullScreenOverlay>
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
  config: FormConfig;
  recordId: string | undefined;
  onClose: () => void;
  onSaved: ((recordId: string) => void) | undefined;
}

function RecordForm({
  slug,
  label,
  systemColumns,
  config,
  recordId,
  onClose,
  onSaved,
}: RecordFormProps) {
  const router = useRouter();
  const isCreate = recordId === undefined;
  const [formError, setFormError] = useState<string | null>(null);

  const prepared = useMemo(
    () => prepare(config, systemColumns, isCreate),
    [config, systemColumns, isCreate],
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

  const navSections = useMemo(
    () => prepared.sections.map((s) => ({ id: s.id, label: s.label })),
    [prepared.sections],
  );
  const { activeId, registerSection, jumpTo } = useActiveSection(
    useMemo(() => navSections.map((s) => s.id), [navSections]),
  );

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
      onSaved?.(record.id);
      onClose();
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
    // sticks to the bottom of the viewport on a long one, without either case
    // needing a measured height.
    <form
      noValidate
      onSubmit={handleSubmit((values) => submit(values, 'save'))}
      className="flex min-h-full flex-col"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-10 px-6">
        <SectionNav slug={slug} sections={navSections} activeId={activeId} onJump={jumpTo} />

        {/* min-w-0 so a wide grid scrolls its own content instead of pushing
            the navigator off screen. */}
        <div className="min-w-0 flex-1 py-8">
          {prepared.sections.length === 0 ? (
            <p className="text-sm text-body">
              {label} has no fields on its form layout yet, so there is nothing to fill in.
            </p>
          ) : (
            prepared.sections.map((section, index) => (
              <section
                key={section.id}
                ref={registerSection(section.id)}
                data-section-id={section.id}
                // Full-width 1px separators between sections, as the frame
                // draws them — never above the first one.
                className={index === 0 ? '' : 'mt-10 border-t border-border pt-10'}
              >
                <h3 className="mb-6 flex items-baseline gap-2 text-lg font-semibold text-heading">
                  <span className="shrink-0 tabular-nums">{index + 1}.</span>
                  <span className="min-w-0 truncate" title={section.label}>
                    {section.label}
                  </span>
                </h3>

                <div
                  className="grid gap-x-6 gap-y-6"
                  // The column count is the Admin's, read off the FormSection
                  // row — a value only known at runtime, so it cannot be a
                  // class. minmax(0,1fr) is what stops a long value from
                  // widening its column past its share.
                  style={{
                    gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))`,
                  }}
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
              </section>
            ))
          )}

          {formError !== null ? (
            <p role="alert" className="mt-8 rounded bg-error/10 px-3 py-2 text-xs text-error">
              {formError}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="sticky bottom-0 border-t border-border bg-surface">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 py-4">
          <Button type="submit" loading={isSubmitting} data-track={saveTrack}>
            Save
          </Button>
          <Button
            variant="secondary"
            disabled={isSubmitting}
            onClick={handleSubmit((values) => submit(values, 'copy'))}
            // Always a create, in both modes — hence the create namespace.
            data-track={`${slug}.create.saveAsNew`}
          >
            Save as New
          </Button>
          <Button variant="ghost" onClick={onClose} data-track={cancelTrack}>
            Cancel
          </Button>

          {/* The frame's "All changes Saved" slot. There is no autosave, so it
              reports the truth instead of a reassurance. */}
          <span className="ml-auto shrink-0 text-xs text-muted">
            {isSubmitting
              ? 'Saving…'
              : isDirty
                ? 'Unsaved changes'
                : isCreate
                  ? 'Nothing entered yet'
                  : 'All changes saved'}
          </span>
        </div>
      </footer>
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
): Prepared {
  const byKey = new Map(config.fields.map((f) => [f.key, f]));

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
      };

      prepared.push({
        field,
        // A colSpan wider than its section would silently create a new column
        // track and break the grid for every field after it.
        colSpan: Math.min(Math.max(1, ref.colSpan), columns),
      });

      if (isWritable(dto)) {
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

/** Keep a value the record already holds selectable, whatever config says now. */
function withCurrent(options: PicklistOption[], stored: unknown): PicklistOption[] {
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
function toValidation(raw: unknown): FieldValidation | null {
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
function toInputValue(type: FieldType, raw: unknown): unknown {
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
