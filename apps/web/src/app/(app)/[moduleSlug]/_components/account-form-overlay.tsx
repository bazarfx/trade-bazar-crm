'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller, type Control, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  FIELD_TYPE_SPECS,
  buildRecordSchema,
  generatePassword,
  normalisePhone,
  passwordSchema,
  USER_FIELD_LIMITS,
  type FieldDef,
  type FieldType,
} from '@crm/shared';
import type { ResolvedSection } from '@crm/core';
import type { FieldDto } from '@/lib/config/fields';
import type { UserListItem } from '@/lib/config/users';
import { api, ApiClientError } from '@/lib/client-api';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import {
  Button,
  Checkbox,
  FieldError,
  FieldLabel,
  Input,
  Popup,
  PopupFooter,
  Select,
} from '@/components/ui';
import { copyText } from './copy-text';
import {
  FieldControl,
  type FormField,
  type PicklistOption,
  type RecordFormValues,
} from './field-control';
import { FormLayoutEdit } from './form-layout-edit';
import {
  toInputValue,
  toValidation,
  withCurrent,
} from './record-form-screen';
import { SectionNav, useActiveSection } from './section-nav';
import { ResetPasswordPopup } from './reset-password-popup';
import { useSpecials } from './specials';

/**
 * The ACCOUNT form — create and edit for the Profile module (spec §5.4, §5.5).
 *
 * LAYOUT-DRIVEN, like every other form in the product. The sections, their
 * order, their column counts and the placement of every field come from the
 * module's resolved FORM layout — so what the Admin arranges in Edit Fields
 * (or the settings layout editor) is exactly what this renders, and an
 * Admin-created field on the Profile module appears here and SAVES here, into
 * `User.custom`, the moment it exists. No deploy, no code change (the prime
 * directive, applied to the one module that used to be the exception).
 *
 * What stays fixed is the ACCOUNT CONTRACT — the controls whose writes carry
 * consequences the field engine does not know about:
 *   - role (locked-role guardrails), department, reporting manager;
 *   - group membership (a join table, not a field — the `groups` field row is
 *     its visibility shell, the same name-gate `toListItem` reads);
 *   - the password (not a field at all: set on create, reset via its own
 *     audited flow, hashed and never read back);
 *   - active/inactive (session revocation + the open-records handover).
 * Those render wherever the layout PLACES their field, but their controls and
 * their write path are this form's own: everything goes through `/api/users`,
 * never the generic record engine, which refuses the user table.
 *
 * EDIT FIELDS — the pencil on the form itself. An Admin with
 * MANAGE_FIELDS_LAYOUTS flips the form into the shared in-place layout editor
 * (`form-layout-edit.tsx`): drag fields between and within sections, rename,
 * re-span, require, add, remove, add sections. Leaving it re-reads the config,
 * so the form is always the layout that was just published.
 */

/** Mirrors `UserAccount` from the server lib — redeclared so this client
 *  module never imports from a `server-only` file. */
interface UserAccount {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  roleId: string;
  departmentId: string | null;
  reportingManagerId: string | null;
  languages: string[];
  isActive: boolean;
  groupIds: string[];
  /** Admin-created field values, straight from `User.custom`. */
  custom?: Record<string, unknown>;
}

interface RoleOption {
  id: string;
  name: string;
}

interface GroupOption {
  id: string;
  name: string;
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface AccountConfig {
  roles: RoleOption[];
  departments: DepartmentOption[];
  groups: GroupOption[];
  managers: UserListItem[];
  fields: FieldDto[];
  sections: ResolvedSection[];
  account: UserAccount | null;
}

export interface AccountFormOverlayProps {
  /** the Profile module's slug — the data-track namespace and the config read */
  slug: string;
  /** module.label — SINGULAR: "User", or whatever the Admin renamed it to. */
  label: string;
  /** Present ⇒ edit that account. Absent ⇒ create a new one. */
  userId?: string;
  onClose: () => void;
  onSaved?: (userId: string) => void;
}

/**
 * The system columns the account contract renders its own controls for. The
 * seeded Profile fields carry keys equal to their columns, which is what
 * `toListItem` and the users list already rely on; the same heuristic is used
 * here because `FieldDto` does not serialise `systemColumn`.
 */
const CONTRACT_KEYS = new Set([
  'fullName',
  'email',
  'phone',
  'roleId',
  'departmentId',
  'reportingManagerId',
  'languages',
  'isActive',
]);

/**
 * The group-membership shell field. Membership is a JOIN TABLE, not a field —
 * this FieldDefinition exists so lists can show a Groups column and layouts
 * can place the control. The name-gate mirrors `toListItem`'s
 * `'groups' in row`; both retire together when membership gains a structural
 * marker.
 */
const MEMBERSHIP_KEY = 'groups';

/** The fixed section appended after the layout: the credential itself, which
 *  is not a field and can never be dragged, hidden or deleted. */
const SIGNIN_SECTION_ID = 'account-signin';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function AccountFormOverlay({ slug, label, userId, onClose, onSaved }: AccountFormOverlayProps) {
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped whenever Edit Fields persisted something — re-reads the config. */
  const [fetchToken, setFetchToken] = useState(0);
  const [layoutEditing, setLayoutEditing] = useState(false);

  const specials = useSpecials();
  const canEditLayout = specials.has('MANAGE_FIELDS_LAYOUTS');

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setLoadError(null);

    async function load() {
      try {
        const [rolesRes, departmentsRes, groupsRes, usersRes, fieldsRes, layoutRes, accountRes] =
          await Promise.all([
            api<{ roles: RoleOption[] }>('/api/roles'),
            // Departments and groups are memberships, not the contract: an
            // Admin who cannot list them can still make the account.
            api<{ departments: DepartmentOption[] }>('/api/departments').catch(() => ({
              departments: [] as DepartmentOption[],
            })),
            api<{ groups: GroupOption[] }>('/api/groups').catch(() => ({
              groups: [] as GroupOption[],
            })),
            api<{ users: UserListItem[] }>('/api/users?take=200').catch(() => ({
              users: [] as UserListItem[],
            })),
            api<{ fields: FieldDto[] }>(`/api/modules/${slug}/fields`),
            api<{ sections: ResolvedSection[] }>(
              `/api/modules/${slug}/layouts/resolved?target=FORM`,
            ),
            userId === undefined
              ? Promise.resolve(null)
              : api<{ user: UserAccount }>(`/api/users/${userId}`),
          ]);

        if (cancelled) return;
        setConfig({
          roles: rolesRes.roles,
          departments: departmentsRes.departments,
          groups: groupsRes.groups,
          managers: usersRes.users,
          fields: fieldsRes.fields,
          sections: layoutRes.sections,
          account: accountRes?.user ?? null,
        });
      } catch (err) {
        if (!cancelled) setLoadError(messageOf(err));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, userId, fetchToken]);

  const title = layoutEditing
    ? `Edit ${label} Fields`
    : `${userId === undefined ? 'Create' : 'Edit'} ${label}`;

  return (
    <FullScreenOverlay title={title} onClose={onClose} trackPrefix={`${slug}.account`}>
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
        <div className="mx-auto max-w-2xl px-6 py-12">
          <p role="alert" className="rounded border border-error bg-surface px-3 py-2 text-sm text-error">
            {loadError}
          </p>
        </div>
      ) : config === null ? (
        <p className="flex h-40 items-center justify-center text-sm text-body">Loading…</p>
      ) : (
        // Keyed on the account AND the fetch token: leaving Edit Fields (or a
        // reload after it) must remount the form so `defaultValues` are read
        // against the fresh config rather than the one it opened with.
        <AccountForm
          key={`${config.account?.id ?? 'new'}:${fetchToken}`}
          slug={slug}
          label={label}
          config={config}
          canEditLayout={canEditLayout}
          onEditLayout={() => setLayoutEditing(true)}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </FullScreenOverlay>
  );
}

// ── config → form ─────────────────────────────────────────────────────────

interface PreparedField {
  kind: 'contract' | 'membership' | 'custom';
  field: FieldDto;
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
  /** the custom fields the form registers, validates and submits */
  customDefs: FieldDef[];
  customKeys: string[];
  phoneKeys: ReadonlySet<string>;
  defaults: RecordFormValues;
}

/** Is this a field the form can write into `User.custom`? Mirrors the server's
 *  own writable-custom rule, so what renders and what saves cannot disagree. */
function isWritableCustom(dto: FieldDto): boolean {
  if (CONTRACT_KEYS.has(dto.key) || dto.key === MEMBERSHIP_KEY) return false;
  if (dto.isDeleted) return false;
  if (FIELD_TYPE_SPECS[dto.type].isDerived) return false;
  if (dto.type === 'FILE' || dto.type === 'IMAGE' || dto.type === 'RECORD_LINK') return false;
  return true;
}

/**
 * Fold the layout and the field list into what the form renders: sections in
 * the Admin's arrangement, each field tagged with which of the three control
 * families draws it, plus the schema inputs for the custom ones.
 */
function prepare(config: AccountConfig): Prepared {
  const byKey = new Map(config.fields.map((f) => [f.key, f]));
  const account = config.account;

  const sections: PreparedSection[] = [];
  const customDefs: FieldDef[] = [];
  const customKeys: string[] = [];
  const phoneKeys = new Set<string>();
  const defaults: RecordFormValues = {};

  for (const resolved of config.sections) {
    const columns = Math.max(1, resolved.columns);
    const prepared: PreparedField[] = [];

    for (const ref of resolved.fields) {
      const dto = byKey.get(ref.key);
      if (!dto || dto.isDeleted) continue;
      if (FIELD_TYPE_SPECS[dto.type].isDerived) continue;

      const colSpan = Math.min(Math.max(1, ref.colSpan), columns);
      if (CONTRACT_KEYS.has(dto.key)) {
        prepared.push({ kind: 'contract', field: dto, colSpan });
        continue;
      }
      if (dto.key === MEMBERSHIP_KEY) {
        prepared.push({ kind: 'membership', field: dto, colSpan });
        continue;
      }

      prepared.push({ kind: 'custom', field: dto, colSpan });
      if (isWritableCustom(dto)) {
        const validation = toValidation(dto.validation);
        customKeys.push(dto.key);
        if (dto.type === 'PHONE') phoneKeys.add(dto.key);
        const options = withCurrent(
          dto.options.filter((o) => !o.isDeleted).map((o) => ({ value: o.value, label: o.label })),
          account?.custom?.[dto.key],
        );
        customDefs.push({
          key: dto.key,
          label: dto.label,
          type: dto.type,
          isRequired: dto.isRequired,
          validation,
          options: options.map((o) => ({ value: o.value })),
        });
        defaults[dto.key] = account
          ? toInputValue(dto.type, account.custom?.[dto.key])
          : toInputValue(dto.type, dto.defaultValue);
      }
    }

    if (prepared.length === 0) continue;
    sections.push({
      id: resolved.sectionId === '' ? 'unsectioned' : resolved.sectionId,
      label: resolved.label === '' ? 'Details' : resolved.label,
      columns,
      fields: prepared,
    });
  }

  return { sections, customDefs, customKeys, phoneKeys, defaults };
}

// ── the form ──────────────────────────────────────────────────────────────

interface AccountFormProps {
  slug: string;
  label: string;
  config: AccountConfig;
  canEditLayout: boolean;
  onEditLayout: () => void;
  onClose: () => void;
  onSaved: ((userId: string) => void) | undefined;
}

function AccountForm({
  slug,
  label,
  config,
  canEditLayout,
  onEditLayout,
  onClose,
  onSaved,
}: AccountFormProps) {
  const router = useRouter();
  const account = config.account;
  const isCreate = account === null;

  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  /** The created account's sign-in details, shown ONCE and never again. */
  const [created, setCreated] = useState<{ fullName: string; email: string; password: string } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const prepared = useMemo(() => prepare(config), [config]);
  const byKey = useMemo(() => new Map(config.fields.map((f) => [f.key, f])), [config.fields]);

  const labelFor = (key: string, fallback: string) => byKey.get(key)?.label ?? fallback;

  // The language choices are the Admin's option rows on the languages field —
  // plus anything the account already speaks whose option has since been
  // retired (invariant 4: the stored value stays selectable).
  const languageOptions = useMemo(() => {
    const own = (byKey.get('languages')?.options ?? [])
      .filter((o) => !o.isDeleted)
      .map((o) => ({ value: o.value, label: o.label }));
    const missing = (account?.languages ?? []).filter((v) => !own.some((o) => o.value === v));
    return [...own, ...missing.map((v) => ({ value: v, label: v }))];
  }, [byKey, account]);

  const managerOptions = useMemo(() => {
    const live = config.managers
      // A deactivated account may still be somebody's HISTORICAL manager,
      // but must not be offered as a new one — and never the user themself.
      .filter((u) => u.isActive !== false && u.id !== account?.id)
      .map((u) => ({ value: u.id, label: u.fullName ?? u.email ?? u.id }));
    // The STORED manager stays selectable whatever the list says now — same
    // rule as retired language options. Without this the native select falls
    // back to the blank row and the next save writes a manager-removal into
    // the append-only log that nobody performed.
    const current = account?.reportingManagerId ?? null;
    if (current !== null && !live.some((o) => o.value === current)) {
      const known = config.managers.find((u) => u.id === current);
      live.push({
        value: current,
        label: known ? `${known.fullName ?? known.email ?? current} (deactivated)` : current,
      });
    }
    return live;
  }, [config.managers, account]);

  // Same rule for the department: a soft-deleted one keeps this account's
  // stored value selectable rather than silently clearing it on save.
  const departmentOptions = useMemo(() => {
    const live = config.departments.map((d) => ({ value: d.id, label: d.name }));
    const current = account?.departmentId ?? null;
    if (current !== null && !live.some((o) => o.value === current)) {
      live.push({ value: current, label: current });
    }
    return live;
  }, [config.departments, account]);

  /**
   * One schema for the whole form: the account contract merged with the
   * generated schema for the custom fields — the SAME `buildRecordSchema` the
   * record engine validates with server-side, so what passes here passes
   * there. The preprocess mirrors the record form's: for CUSTOM keys only,
   * blanks mean absent and phones normalise; contract keys handle '' in the
   * payload mapping instead.
   */
  const schema = useMemo(() => {
    const contract = z.object({
      fullName: z.string().trim().min(1, 'Full name is required').max(USER_FIELD_LIMITS.fullName),
      email: z
        .string()
        .trim()
        .toLowerCase()
        .email('Enter a valid email address')
        .max(USER_FIELD_LIMITS.email),
      phone: z.string().trim().max(USER_FIELD_LIMITS.phone),
      roleId: z.string().min(1, 'Choose a role'),
      departmentId: z.string(),
      reportingManagerId: z.string(),
      groupIds: z.array(z.string()),
      languages: z.array(z.string()),
      isActive: z.boolean(),
      password: isCreate ? passwordSchema : z.string(),
    });
    const custom = buildRecordSchema(prepared.customDefs);
    const merged = contract.and(custom);
    const customKeySet = new Set(prepared.customKeys);
    return z.preprocess((input: unknown) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!customKeySet.has(key) || typeof value !== 'string') {
          out[key] = value;
        } else if (value.trim() === '') {
          out[key] = undefined;
        } else {
          out[key] = prepared.phoneKeys.has(key) ? normalisePhone(value) : value;
        }
      }
      return out;
    }, merged);
  }, [isCreate, prepared]);

  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    watch,
    getValues,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<RecordFormValues>({
    // The value bag has no static shape — custom keys are config — so the
    // resolver is the runtime authority, exactly as on the record form.
    resolver: zodResolver(schema) as never,
    defaultValues: {
      fullName: account?.fullName ?? '',
      email: account?.email ?? '',
      phone: account?.phone ?? '',
      roleId: account?.roleId ?? '',
      departmentId: account?.departmentId ?? '',
      reportingManagerId: account?.reportingManagerId ?? '',
      groupIds: account?.groupIds ?? [],
      languages: account?.languages ?? [],
      isActive: account?.isActive ?? true,
      password: '',
      ...prepared.defaults,
    },
  });

  const navSections = useMemo(
    () => [
      ...prepared.sections.map((s) => ({ id: s.id, label: s.label })),
      { id: SIGNIN_SECTION_ID, label: 'Sign-in' },
    ],
    [prepared.sections],
  );
  const { activeId, registerSection, jumpTo } = useActiveSection(
    useMemo(() => navSections.map((s) => s.id), [navSections]),
  );

  const track = `${slug}.account.field.input`;

  async function submit(values: RecordFormValues) {
    setFormError(null);

    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

    // '' is the form's "unset"; the wire contract wants null. Blanks never
    // travel as empty strings.
    const payload: Record<string, unknown> = {
      fullName: str(values['fullName']),
      email: str(values['email']),
      phone: str(values['phone']) === '' ? null : str(values['phone']),
      roleId: str(values['roleId']),
      departmentId: str(values['departmentId']) === '' ? null : str(values['departmentId']),
      reportingManagerId:
        str(values['reportingManagerId']) === '' ? null : str(values['reportingManagerId']),
      groupIds: arr(values['groupIds']),
      languages: arr(values['languages']),
      isActive: values['isActive'] === true,
    };
    if (isCreate) payload['password'] = str(values['password']);

    // Custom values ride in their own bag, validated again server-side against
    // the same FieldDefinition rows. An emptied field travels as null — an
    // explicit clear — because the update path merges sent keys.
    if (prepared.customKeys.length > 0) {
      const custom: Record<string, unknown> = {};
      const raw = getValues();
      for (const key of prepared.customKeys) {
        const value = values[key];
        if (isCreate) {
          if (value !== undefined) custom[key] = value;
          continue;
        }
        // On edit, send only what changed — an untouched phone must not be
        // re-normalised into a diff nobody made (the same rule the record
        // form's PATCH follows).
        if (raw[key] === prepared.defaults[key]) continue;
        custom[key] = value === undefined ? null : value;
      }
      if (Object.keys(custom).length > 0) payload['custom'] = custom;
    }

    try {
      const res = await api<{ user: { id: string } }>(
        isCreate ? '/api/users' : `/api/users/${account.id}`,
        { method: isCreate ? 'POST' : 'PATCH', body: JSON.stringify(payload) },
      );
      onSaved?.(res.user.id);
      // The list behind this overlay is a server component; refreshing is what
      // makes the new row appear.
      router.refresh();
      if (isCreate) {
        // The one moment the password can still be read. The overlay stays up
        // underneath so closing the pop-up is what ends the flow.
        setCreated({
          fullName: str(values['fullName']),
          email: str(values['email']),
          password: str(values['password']),
        });
        return;
      }
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.fields) {
        for (const [key, messages] of Object.entries(err.fields)) {
          setError(key, { type: 'server', message: messages[0] ?? 'Invalid value' });
        }
      }
      setFormError(messageOf(err));
    }
  }

  /** One contract control, drawn where the LAYOUT put its field. Keyed on the
   *  field KEY (which the seed fixes equal to the column) — never a label. */
  function contractControl(dto: FieldDto): React.ReactNode {
    switch (dto.key) {
      case 'fullName':
        return (
          <div className="min-w-0">
            <FieldLabel htmlFor="account-fullName" required>
              {labelFor('fullName', 'Full Name')}
            </FieldLabel>
            <Input
              id="account-fullName"
              placeholder="Enter..."
              autoComplete="off"
              tone="form"
              data-track={track}
              aria-invalid={errorFor(errors, 'fullName') !== undefined}
              {...register('fullName')}
            />
            <FieldError>{errorFor(errors, 'fullName')}</FieldError>
          </div>
        );
      case 'email':
        return (
          <div className="min-w-0">
            <FieldLabel htmlFor="account-email" required>
              {labelFor('email', 'Email (login)')}
            </FieldLabel>
            <Input
              id="account-email"
              type="email"
              placeholder="name@company.com"
              autoComplete="off"
              tone="form"
              data-track={track}
              aria-invalid={errorFor(errors, 'email') !== undefined}
              {...register('email')}
            />
            <p className="mt-1 text-xs text-muted">
              Used to sign in — the part before the @ works as a username too.
            </p>
            <FieldError>{errorFor(errors, 'email')}</FieldError>
          </div>
        );
      case 'phone':
        return (
          <div className="min-w-0">
            <FieldLabel htmlFor="account-phone">{labelFor('phone', 'Phone')}</FieldLabel>
            <Input
              id="account-phone"
              type="tel"
              inputMode="tel"
              placeholder="Enter..."
              autoComplete="off"
              tone="form"
              data-track={track}
              aria-invalid={errorFor(errors, 'phone') !== undefined}
              {...register('phone')}
            />
            <FieldError>{errorFor(errors, 'phone')}</FieldError>
          </div>
        );
      case 'reportingManagerId':
        return (
          <div className="min-w-0">
            <FieldLabel htmlFor="account-manager">
              {labelFor('reportingManagerId', 'Reporting Manager')}
            </FieldLabel>
            <Select
              id="account-manager"
              tone="form"
              data-track={track}
              aria-invalid={errorFor(errors, 'reportingManagerId') !== undefined}
              {...register('reportingManagerId')}
            >
              <option value="">—</option>
              {managerOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <FieldError>{errorFor(errors, 'reportingManagerId')}</FieldError>
          </div>
        );
      case 'roleId':
        return (
          <div className="min-w-0">
            <FieldLabel htmlFor="account-role" required>
              {labelFor('roleId', 'Role')}
            </FieldLabel>
            <Select
              id="account-role"
              tone="form"
              data-track={track}
              aria-invalid={errorFor(errors, 'roleId') !== undefined}
              {...register('roleId')}
            >
              <option value="">Select…</option>
              {config.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-muted">
              Decides what this account can see and do — set in Roles &amp; permissions.
            </p>
            <FieldError>{errorFor(errors, 'roleId')}</FieldError>
          </div>
        );
      case 'departmentId':
        return (
          <div className="min-w-0">
            <FieldLabel htmlFor="account-department">
              {labelFor('departmentId', 'Department')}
            </FieldLabel>
            <Select
              id="account-department"
              tone="form"
              data-track={track}
              aria-invalid={errorFor(errors, 'departmentId') !== undefined}
              {...register('departmentId')}
            >
              <option value="">—</option>
              {departmentOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <FieldError>{errorFor(errors, 'departmentId')}</FieldError>
          </div>
        );
      case 'languages':
        return (
          <CheckboxGroup
            control={control}
            name="languages"
            label={labelFor('languages', 'Languages Spoken')}
            options={languageOptions}
            emptyNotice="The languages field has no options yet."
            hint="Language-matched leads route to users who speak them."
            track={track}
          />
        );
      case 'isActive':
        return (
          <div className="min-w-0">
            <FieldLabel htmlFor="account-active">{labelFor('isActive', 'Status')}</FieldLabel>
            <div className="flex h-[34px] items-center">
              <Controller
                control={control}
                name="isActive"
                render={({ field: bound }) => (
                  <Checkbox
                    id="account-active"
                    checked={bound.value === true}
                    onBlur={bound.onBlur}
                    onChange={(e) => bound.onChange(e.target.checked)}
                    data-track={track}
                    label="Active — can sign in"
                  />
                )}
              />
            </div>
            <p className="mt-1 text-xs text-muted">
              Deactivating signs the user out everywhere; their open records must be handed over
              first.
            </p>
          </div>
        );
      default:
        return null;
    }
  }

  /** A custom field, rendered exactly as the record form renders it. */
  function customControl(dto: FieldDto): React.ReactNode {
    const writable = isWritableCustom(dto);
    const validation = toValidation(dto.validation);
    const options = withCurrent(
      dto.options.filter((o) => !o.isDeleted).map((o) => ({ value: o.value, label: o.label })),
      account?.custom?.[dto.key],
    );
    const field: FormField = {
      key: dto.key,
      label: dto.label,
      type: dto.type,
      helpText: dto.helpText,
      isRequired: dto.isRequired && writable,
      maxLength: validation?.maxLength ?? null,
      options,
      linkOptions: null,
      hint: null,
      locked: null,
    };
    return (
      <FieldControl
        slug={slug}
        field={field}
        register={register}
        control={control}
        error={errorFor(errors, dto.key)}
      />
    );
  }

  return (
    <>
      <form noValidate onSubmit={handleSubmit(submit)} className="flex min-h-full flex-col">
        <div className="mx-auto flex w-full max-w-5xl flex-1 gap-10 px-6">
          <SectionNav slug={slug} sections={navSections} activeId={activeId} onJump={jumpTo} />

          <div className="flex min-w-0 flex-1 flex-col gap-6 py-8">
            {/* The door into editing the form ITSELF — drag, rename, add,
                everything. Drawn only for a holder of the layouts special;
                the server gates every write it leads to regardless. */}
            {canEditLayout ? (
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onEditLayout}
                  data-track={`${slug}.account.editfields.open`}
                >
                  Edit Fields
                </Button>
              </div>
            ) : null}

            {prepared.sections.map((section, index) => (
              <section
                key={section.id}
                ref={registerSection(section.id)}
                data-section-id={section.id}
                className="scroll-mt-6 rounded-lg border border-border bg-surface"
              >
                <div className="flex items-center gap-3 border-b border-border px-6 py-4">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-border bg-background text-xs font-medium tabular-nums text-heading">
                    {index + 1}
                  </span>
                  <h3 className="min-w-0 truncate text-sm font-medium text-heading" title={section.label}>
                    {section.label}
                  </h3>
                </div>
                <div
                  className="grid gap-x-6 gap-y-5 p-6"
                  // The column count is the Admin's, read off the FormSection
                  // row — 2 on a fresh install, editable in Edit Fields.
                  style={{ gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))` }}
                >
                  {section.fields.map(({ kind, field, colSpan }) => (
                    <div key={field.key} style={{ gridColumn: `span ${colSpan}` }}>
                      {kind === 'contract' ? (
                        contractControl(field)
                      ) : kind === 'membership' ? (
                        <CheckboxGroup
                          control={control}
                          name="groupIds"
                          label={field.label}
                          options={config.groups.map((g) => ({ value: g.id, label: g.name }))}
                          emptyNotice="No groups yet — create them under the Groups tab."
                          hint="Groups are the backbone of round-robin assignment."
                          track={track}
                        />
                      ) : (
                        customControl(field)
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}

            {/* Sign-in — fixed after the layout, because the credential is not
                a field: it cannot be dragged, hidden, renamed or deleted. */}
            <section
              ref={registerSection(SIGNIN_SECTION_ID)}
              data-section-id={SIGNIN_SECTION_ID}
              className="scroll-mt-6 rounded-lg border border-border bg-surface"
            >
              <div className="flex items-center gap-3 border-b border-border px-6 py-4">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-border bg-background text-xs font-medium tabular-nums text-heading">
                  {prepared.sections.length + 1}
                </span>
                <h3 className="min-w-0 truncate text-sm font-medium text-heading">Sign-in</h3>
              </div>
              <div className="grid grid-cols-1 gap-x-6 gap-y-5 p-6 sm:grid-cols-2">
                {isCreate ? (
                  <div className="min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <FieldLabel htmlFor="account-password" required>
                        Password
                      </FieldLabel>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          className="text-xs font-medium text-primary hover:underline"
                          onClick={() => {
                            setValue('password', generatePassword(), {
                              shouldDirty: true,
                              shouldValidate: true,
                            });
                            setShowPassword(true);
                          }}
                          data-track={`${slug}.account.password.generate`}
                        >
                          Generate
                        </button>
                        <button
                          type="button"
                          className="text-xs font-medium text-body hover:text-heading"
                          onClick={() => setShowPassword((v) => !v)}
                          data-track={`${slug}.account.password.toggle`}
                        >
                          {showPassword ? 'Hide' : 'Show'}
                        </button>
                        <CopyButton
                          value={() => (typeof watch('password') === 'string' ? (watch('password') as string) : '')}
                          track={`${slug}.account.password.copy`}
                        />
                      </div>
                    </div>
                    <Input
                      id="account-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="At least 10 characters"
                      autoComplete="new-password"
                      tone="form"
                      data-track={track}
                      aria-invalid={errorFor(errors, 'password') !== undefined}
                      {...register('password')}
                    />
                    <p className="mt-1 text-xs text-muted">
                      At least 10 characters, with an upper and a lower case letter and a number.
                      It is shown once after saving — nobody can read it back later.
                    </p>
                    <FieldError>{errorFor(errors, 'password')}</FieldError>
                  </div>
                ) : (
                  <div className="min-w-0">
                    <FieldLabel htmlFor="account-password-set">Password</FieldLabel>
                    <div className="flex items-center gap-3">
                      <Input
                        id="account-password-set"
                        disabled
                        readOnly
                        value="••••••••••"
                        tone="form"
                        title="Passwords are stored only as a hash and cannot be viewed."
                        data-track={track}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setResetOpen(true)}
                        data-track={`${slug}.account.reset.open`}
                      >
                        Reset password
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Stored as a hash — it can be replaced, never read back.
                    </p>
                  </div>
                )}
              </div>
            </section>

            {formError !== null ? (
              <p role="alert" className="rounded border border-error bg-surface px-3 py-2 text-xs text-error">
                {formError}
              </p>
            ) : null}
          </div>
        </div>

        <footer className="sticky bottom-0 border-t border-border bg-surface">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 py-4">
            <Button
              type="submit"
              loading={isSubmitting}
              data-track={isCreate ? `${slug}.account.create.submit` : `${slug}.account.edit.submit`}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={onClose}
              data-track={isCreate ? `${slug}.account.create.cancel` : `${slug}.account.edit.cancel`}
            >
              Cancel
            </Button>
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

      {/* The one moment the password is readable. Closing it closes the flow. */}
      {created !== null ? (
        <Popup
          title="Account created"
          width={511}
          open
          onClose={() => {
            setCreated(null);
            onClose();
          }}
          trackPrefix={`${slug}.account.created`}
          footer={
            <PopupFooter
              trackPrefix={`${slug}.account.created`}
              next={{
                label: 'Done',
                onClick: () => {
                  setCreated(null);
                  onClose();
                },
              }}
            />
          }
        >
          <p className="text-sm text-body">
            <span className="font-medium text-heading">{created.fullName}</span> can sign in with
            these details. The password is shown only this once — copy it now and share it
            securely.
          </p>
          <CredentialRow label="Email" value={created.email} track={`${slug}.account.created.email.copy`} />
          <CredentialRow
            label="Password"
            value={created.password}
            track={`${slug}.account.created.password.copy`}
          />
        </Popup>
      ) : null}

      {!isCreate && resetOpen ? (
        <ResetPasswordPopup
          slug={slug}
          userId={account.id}
          userName={account.fullName}
          onClose={() => setResetOpen(false)}
        />
      ) : null}
    </>
  );
}

// ── little pieces ─────────────────────────────────────────────────────────

/** The value bag has no static shape, so its error bag has none either. */
function errorFor(errors: FieldErrors<RecordFormValues>, key: string): string | undefined {
  const entry = errors[key] as { message?: unknown } | undefined;
  return typeof entry?.message === 'string' ? entry.message : undefined;
}

interface CheckboxGroupProps {
  control: Control<RecordFormValues>;
  name: 'groupIds' | 'languages';
  label: string;
  options: { value: string; label: string }[];
  emptyNotice: string;
  hint: string;
  track: string;
}

/** The same checkbox-group control the record form draws for a multi-select:
 *  every option visible, keyboard reachable, no popup to trap focus. */
function CheckboxGroup({ control, name, label, options, emptyNotice, hint, track }: CheckboxGroupProps) {
  return (
    <div className="min-w-0">
      <FieldLabel htmlFor={undefined} tone="form">{label}</FieldLabel>
      <Controller
        control={control}
        name={name}
        render={({ field: bound }) => {
          const selected = Array.isArray(bound.value)
            ? bound.value.filter((v): v is string => typeof v === 'string')
            : [];
          return (
            <div
              role="group"
              aria-label={label}
              className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded border border-border bg-surface p-3"
            >
              {options.length === 0 ? (
                <p className="text-xs text-body">{emptyNotice}</p>
              ) : (
                options.map((o) => (
                  <Checkbox
                    key={o.value}
                    checked={selected.includes(o.value)}
                    onBlur={bound.onBlur}
                    onChange={(e) =>
                      bound.onChange(
                        e.target.checked
                          ? [...selected, o.value]
                          : selected.filter((v) => v !== o.value),
                      )
                    }
                    data-track={track}
                    label={
                      <span className="block truncate" title={o.label}>
                        {o.label}
                      </span>
                    }
                  />
                ))
              )}
            </div>
          );
        }}
      />
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

function CopyButton({ value, track }: { value: () => string; track: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={cnCopy(state)}
      onClick={() => {
        void copyText(value()).then((ok) => {
          // A failure STAYS on screen: these buttons guard one-time credential
          // displays, and an Admin who believes a failed copy succeeded closes
          // the only view of the password there will ever be.
          setState(ok ? 'copied' : 'failed');
          if (ok) setTimeout(() => setState('idle'), 1500);
        });
      }}
      data-track={track}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — select it by hand' : 'Copy'}
    </button>
  );
}

function cnCopy(state: 'idle' | 'copied' | 'failed'): string {
  return state === 'failed'
    ? 'text-xs font-medium text-error'
    : 'text-xs font-medium text-body hover:text-heading';
}

function CredentialRow({ label, value, track }: { label: string; value: string; track: string }) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-heading">{label}</p>
      <div className="flex items-center gap-3 rounded border border-border bg-background px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-sm text-heading" title={value}>
          {value}
        </code>
        <CopyButton value={() => value} track={track} />
      </div>
    </div>
  );
}
