'use client';

import { useEffect, useState } from 'react';
import {
  DEAL_HANDOVER_TARGETS,
  type DealHandoverRule,
  type DealHandoverTarget,
  type SettingValues,
  type SettingsPatch,
} from '@crm/shared';
import {
  assignable,
  useDirectory,
  userLabel,
} from '@/app/(app)/[moduleSlug]/_components/directory';
import { Button, FieldError, FieldLabel, Panel, PanelBody, PanelHeader, Select } from '@/components/ui';
import { api } from '@/lib/client-api';

/**
 * The POINTERS that aim platform behaviour at Admin-created rows.
 *
 * The spec says unmatched ARK leads go to "the Seniors of that language",
 * everything else falls to a "default pool", and a new deal goes to whoever
 * the handover rule names (spec §7.1). All of those are rows the client
 * creates, renames and deletes at will, so nothing here — and nothing in the
 * engine — may match any of them by NAME. Instead the Admin NOMINATES a Role
 * id, a Group id, a User id, exactly as status logic reads `tag` and never
 * `name`. Rename the role to "Desk Leads" this afternoon and routing follows
 * it, with no migration and no deploy.
 *
 * This screen therefore has one job beyond storing ids: saying, in words,
 * what the system does when they are NOT set. An unset pointer is not an
 * error — the engine drops to the next tier and the record still gets an
 * owner — but the owner is then the Admin, and a workspace where every lead
 * and every deal quietly lands on one person looks exactly like a configured
 * one from the outside. That difference is what the copy here exists to
 * remove.
 */

/** `/api/roles` — the wider admin shape carries counts this screen ignores. */
export interface RoleOption {
  id: string;
  name: string;
}

/**
 * A live group, read from Prisma by the server page (there is no groups API
 * yet). `activeMembers` is here because a pool with nobody active in it is
 * indistinguishable from an unset pool at runtime, and the Admin deserves to
 * see that before it costs them a day of leads.
 */
export interface GroupOption {
  id: string;
  name: string;
  language: string | null;
  activeMembers: number;
}

/** `''` in a native select is the "not nominated" option; the stored value is null. */
const UNSET = '';

const toStored = (value: string): string | null => (value === UNSET ? null : value);
const toControl = (value: string | null): string => value ?? UNSET;

/** The handover rule as two controls: which table, and which row in it. */
interface HandoverDraft {
  type: '' | DealHandoverTarget;
  id: string;
}

const NO_HANDOVER: HandoverDraft = { type: '', id: '' };

const toHandoverDraft = (rule: DealHandoverRule | null): HandoverDraft =>
  rule === null ? NO_HANDOVER : { type: rule.type, id: rule.id };

const sameHandover = (a: HandoverDraft, b: HandoverDraft): boolean => a.type === b.type && a.id === b.id;

/** What each target means, in the Admin's words. Keyed on the union so a
 *  target added to `DEAL_HANDOVER_TARGETS` without copy is a type error. */
const TARGET_COPY: Record<DealHandoverTarget, { label: string; picker: string; how: string }> = {
  user: {
    label: 'A specific user',
    picker: 'Who',
    how: 'Every new deal goes to this one person while they are active.',
  },
  role: {
    label: 'A role',
    picker: 'Which role',
    how: 'Round-robin among the active holders of this role, preferring those who speak the deal’s language.',
  },
  pool: {
    label: 'A pool',
    picker: 'Which group',
    how: 'Round-robin among the active members of this group, preferring those who speak the deal’s language.',
  },
};

interface StoredValues {
  senior: string;
  pool: string;
  handover: HandoverDraft;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function AssignmentSettingsForm({ groups }: { groups: GroupOption[] }) {
  const [roles, setRoles] = useState<RoleOption[]>([]);

  // What the server holds, and what the controls show. Kept apart so "dirty"
  // is a fact rather than a guess, and so a refused save can leave the
  // controls where the Admin put them instead of silently reverting.
  const [stored, setStored] = useState<StoredValues | null>(null);
  const [senior, setSenior] = useState(UNSET);
  const [pool, setPool] = useState(UNSET);
  const [handover, setHandover] = useState<HandoverDraft>(NO_HANDOVER);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // The user directory only when the rule names a person: nobody else pays
  // for a list nothing will draw.
  const directory = useDirectory(handover.type === 'user');

  useEffect(() => {
    let cancelled = false;

    // Both reads or neither: a screen that knew the settings but not the roles
    // could only draw a picker with the current value missing from it, and the
    // Admin would read that as "nothing is nominated".
    Promise.all([
      api<{ settings: SettingValues }>('/api/settings'),
      api<{ roles: RoleOption[] }>('/api/roles'),
    ])
      .then(([settingsRes, rolesRes]) => {
        if (cancelled) return;
        const next = adopt(settingsRes.settings);
        setRoles(rolesRes.roles);
        setStored(next);
        setSenior(next.senior);
        setPool(next.pool);
        setHandover(next.handover);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(messageOf(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function adopt(settings: SettingValues): StoredValues {
    return {
      senior: toControl(settings['assignment.seniorRoleId']),
      pool: toControl(settings['assignment.defaultPoolGroupId']),
      handover: toHandoverDraft(settings['deals.handoverRule']),
    };
  }

  const dirty =
    stored !== null &&
    (senior !== stored.senior || pool !== stored.pool || !sameHandover(handover, stored.handover));

  function change(next: () => void) {
    next();
    // A stale "Saved" line above changed controls is a lie about the current
    // state, which is the one thing this screen cannot afford.
    setSaved(false);
    setSaveError(null);
  }

  function save() {
    if (stored === null || !dirty) return;

    // A target with nobody chosen is a decision the Admin has not finished:
    // refuse it here rather than save "no rule" under a control that says
    // "a role".
    if (handover.type !== '' && handover.id === '') {
      setSaveError(`Choose ${TARGET_COPY[handover.type].picker.toLowerCase()} the handover rule points at, or set it back to the Admin.`);
      return;
    }

    // PARTIAL by design: only the control that moved is written, so this tab
    // cannot revert a pointer another Admin changed while it was open.
    const patch: SettingsPatch = {};
    if (senior !== stored.senior) patch['assignment.seniorRoleId'] = toStored(senior);
    if (pool !== stored.pool) patch['assignment.defaultPoolGroupId'] = toStored(pool);
    if (!sameHandover(handover, stored.handover)) {
      patch['deals.handoverRule'] =
        handover.type === '' ? null : { type: handover.type, id: handover.id };
    }

    setBusy(true);
    setSaveError(null);
    setSaved(false);

    api<{ settings: SettingValues }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
      .then((res) => {
        setBusy(false);
        // Adopt what the server RESOLVED, never what was sent: the write
        // proves each pointer against a live row and answers with the stored
        // truth, which is also how a concurrent change by another Admin
        // becomes visible here rather than being overwritten.
        const next = adopt(res.settings);
        setStored(next);
        setSenior(next.senior);
        setPool(next.pool);
        setHandover(next.handover);
        setSaved(true);
      })
      .catch((err: unknown) => {
        setBusy(false);
        // The controls keep the Admin's choice. A 422 here means the row was
        // deleted between opening this screen and saving it, and the fix is to
        // pick another one — not to lose what was typed.
        setSaveError(messageOf(err));
      });
  }

  function discard() {
    if (stored === null) return;
    setSenior(stored.senior);
    setPool(stored.pool);
    setHandover(stored.handover);
    setSaved(false);
    setSaveError(null);
  }

  const seniorRole = roles.find((r) => r.id === senior);
  const poolGroup = groups.find((g) => g.id === pool);
  // A pointer whose row was deleted after it was nominated. The write path
  // refuses to store one, but it can rot in place afterwards — and it must not
  // be quietly redrawn as "not nominated", which would make the next save
  // clear a setting the Admin never touched.
  const seniorMissing = senior !== UNSET && seniorRole === undefined;
  const poolMissing = pool !== UNSET && poolGroup === undefined;

  // The handover target, resolved to a name for the summary.
  const handoverUsers = assignable(directory.users);
  const handoverRole = handover.type === 'role' ? roles.find((r) => r.id === handover.id) : undefined;
  const handoverGroup = handover.type === 'pool' ? groups.find((g) => g.id === handover.id) : undefined;
  const handoverUser = handover.type === 'user' ? handoverUsers.find((u) => u.id === handover.id) : undefined;
  const handoverMissing =
    handover.type !== '' &&
    handover.id !== '' &&
    (handover.type === 'role'
      ? handoverRole === undefined
      : handover.type === 'pool'
        ? handoverGroup === undefined
        : !directory.loading && handoverUser === undefined);

  const loading = stored === null && loadError === null;

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader title="How a record gets an owner" />
        <PanelBody className="flex flex-col gap-4 text-sm text-body">
          <p>
            Every lead has an owner from the second it enters the system. There is no unassigned
            state and no queue to be picked out of — the engine works down this list and stops at
            the first step that can name an <strong className="font-medium text-heading">active</strong>{' '}
            person.
          </p>
          {/* A block list, not a flex column: a flex container blockifies its
              children and the numbering marker is the first casualty. */}
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              A lead from a campaign, an import or the create form goes to the group whose language
              matches the lead&apos;s, round-robin across that group&apos;s active members.
            </li>
            <li>
              A lead from ARK Terminal goes to the <strong className="font-medium text-heading">senior
              pool</strong> — the active holders of the role nominated below who speak the
              lead&apos;s language, round-robin.
            </li>
            <li>
              Anything neither step could place goes to the{' '}
              <strong className="font-medium text-heading">default pool</strong> group nominated
              below, round-robin across its active members.
            </li>
            <li>
              If nothing above can name anybody, the record goes to the{' '}
              <strong className="font-medium text-heading">Admin</strong>.
            </li>
          </ol>
          <p>
            A deactivated user is never a candidate at any step: they keep every record they
            already own, but they receive no new ones. A group with nobody active in it counts the
            same as no group at all.
          </p>
          <p>
            Whichever step placed the record is written onto that record&apos;s timeline, so a lead
            can always answer why it landed where it did — and every later reassignment is written
            there too, old owner to new owner.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Senior pool and default pool" />
        <PanelBody className="flex flex-col gap-8">
          {loadError !== null ? (
            <p role="alert" className="rounded bg-error/10 px-3 py-2 text-sm text-error">
              These settings could not be read: {loadError}
            </p>
          ) : null}

          {/* ── senior pool role ─────────────────────────────────────────── */}
          <div>
            <FieldLabel htmlFor="assignment-senior">Senior pool role</FieldLabel>
            <Select
              id="assignment-senior"
              value={senior}
              disabled={loading || loadError !== null || busy}
              onChange={(e) => change(() => setSenior(e.target.value))}
              data-track="settings.assignment.senior.select"
            >
              {/* While the read is in flight the control must not sit on
                  "Not nominated": that is a real state with real consequences,
                  and showing it before knowing it would be a lie the Admin
                  could act on. */}
              {loading ? (
                <option value={UNSET}>Reading the current setting…</option>
              ) : (
                <>
                  <option value={UNSET}>
                    Not nominated — ARK leads fall through to the default pool
                  </option>
                  {/* Only reachable when the nominated role has been deleted
                      since it was chosen. Kept so the picker shows the stored
                      state rather than a comfortable fiction. */}
                  {seniorMissing ? (
                    <option value={senior}>A role that no longer exists</option>
                  ) : null}
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </>
              )}
            </Select>
            <p className="mt-1.5 text-xs text-body">
              Which role your seniors hold. This stores the role, not its name — rename it to
              anything and routing follows. Leave it unset and step 2 is skipped entirely: every
              lead ARK could not match goes straight to the default pool, and to the Admin if no
              pool is nominated either.
            </p>
            {seniorMissing ? (
              <p role="alert" className="mt-2 text-xs text-error">
                The role nominated here has been deleted. ARK leads are already falling through to
                the default pool. Choose another role or clear this — saving it as it stands will
                be refused.
              </p>
            ) : null}
          </div>

          {/* ── default pool group ───────────────────────────────────────── */}
          <div>
            <FieldLabel htmlFor="assignment-pool">Default pool group</FieldLabel>
            <Select
              id="assignment-pool"
              value={pool}
              // `!poolMissing` in the last test on purpose: with no groups AND
              // a rotten pointer, a disabled control would trap the Admin with
              // a setting they can neither fix nor clear.
              disabled={loading || loadError !== null || busy || (groups.length === 0 && !poolMissing)}
              onChange={(e) => change(() => setPool(e.target.value))}
              data-track="settings.assignment.pool.select"
            >
              {loading ? (
                <option value={UNSET}>Reading the current setting…</option>
              ) : (
                <>
                  <option value={UNSET}>Not nominated — unplaced records go to the Admin</option>
                  {poolMissing ? (
                    <option value={pool}>A group that no longer exists</option>
                  ) : null}
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                      {group.language === null ? '' : ` · ${group.language}`}
                      {` · ${group.activeMembers} active`}
                    </option>
                  ))}
                </>
              )}
            </Select>
            <p className="mt-1.5 text-xs text-body">
              Where a record goes when no language group and no senior could take it. Leave it
              unset and step 3 is skipped: those records still get an owner — the Admin — but one
              person rather than the team you meant.
            </p>
            {groups.length === 0 ? (
              <p className="mt-2 text-xs text-body">
                No groups exist yet, so there is nothing to nominate. Until one does, every record
                the first two steps cannot place belongs to the Admin.
              </p>
            ) : null}
            {poolMissing ? (
              <p role="alert" className="mt-2 text-xs text-error">
                The group nominated here has been deleted. Unplaced records are already going to
                the Admin. Choose another group or clear this — saving it as it stands will be
                refused.
              </p>
            ) : null}
            {poolGroup !== undefined && poolGroup.activeMembers === 0 ? (
              <p role="alert" className="mt-2 text-xs text-error">
                {poolGroup.name} has no active members, so it can never catch anything — records
                reaching step 3 go to the Admin instead. Add members to it, or nominate a group
                that has some.
              </p>
            ) : null}
          </div>

          {/* ── what the two choices mean, right now ─────────────────────── */}
          {!loading && loadError === null ? (
            <div className="rounded border border-border bg-background px-4 py-3">
              <p className="text-xs font-medium text-heading">As configured right now</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-body">
                <li>
                  Leads from ARK Terminal that match no existing record:{' '}
                  {seniorRole === undefined ? (
                    <>
                      no senior pool is nominated, so they skip straight to the next step.
                    </>
                  ) : (
                    <>
                      round-robin among active <strong className="font-medium text-heading">{seniorRole.name}</strong>{' '}
                      holders who speak the lead&apos;s language.
                    </>
                  )}
                </li>
                <li>
                  Records no language group and no senior could take:{' '}
                  {poolGroup === undefined || poolGroup.activeMembers === 0 ? (
                    <>they go to the Admin.</>
                  ) : (
                    <>
                      round-robin among the {poolGroup.activeMembers} active{' '}
                      {poolGroup.activeMembers === 1 ? 'member' : 'members'} of{' '}
                      <strong className="font-medium text-heading">{poolGroup.name}</strong>.
                    </>
                  )}
                </li>
              </ul>
            </div>
          ) : null}
        </PanelBody>
      </Panel>

      {/* ── the deal handover rule (spec §7.1) ──────────────────────────── */}
      <Panel>
        <PanelHeader title="Deal handover rule" />
        <PanelBody className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 text-sm text-body">
            <p>
              A deal is created the moment ARK reports a deposit on a lead. It carries two
              separate people: <strong className="font-medium text-heading">Closed By</strong>, the
              agent who owned the lead at that moment — permanent credit, never changed by anyone
              — and the <strong className="font-medium text-heading">Deal Owner</strong>, who
              handles the customer from now on. This rule decides the second one.
            </p>
            <p>
              Until it is set, every new deal is owned by the{' '}
              <strong className="font-medium text-heading">Admin</strong>. A deal is never
              unowned, so the fallback is a person, not a queue — but one person for every
              customer is rarely what you mean. Whatever you nominate, a deactivated user is never
              chosen, and an empty role or pool falls back to the Admin too. The owner can be
              transferred later by anyone with <em>Transfer deal ownership</em>; every transfer is
              on the deal&apos;s timeline.
            </p>
          </div>

          <div>
            <FieldLabel htmlFor="handover-target">New deals go to</FieldLabel>
            <Select
              id="handover-target"
              value={handover.type}
              disabled={loading || loadError !== null || busy}
              onChange={(e) =>
                change(() =>
                  setHandover({ type: e.target.value as '' | DealHandoverTarget, id: '' }),
                )
              }
              data-track="settings.assignment.handover.target.select"
            >
              {loading ? (
                <option value="">Reading the current setting…</option>
              ) : (
                <>
                  <option value="">Not set — the Admin owns every new deal</option>
                  {DEAL_HANDOVER_TARGETS.map((t) => (
                    <option key={t} value={t}>
                      {TARGET_COPY[t].label}
                    </option>
                  ))}
                </>
              )}
            </Select>
            {handover.type !== '' ? (
              <p className="mt-1.5 text-xs text-body">{TARGET_COPY[handover.type].how}</p>
            ) : null}
          </div>

          {handover.type !== '' ? (
            <div>
              <FieldLabel htmlFor="handover-id" required>
                {TARGET_COPY[handover.type].picker}
              </FieldLabel>
              <Select
                id="handover-id"
                value={handover.id}
                disabled={busy || (handover.type === 'user' && directory.loading)}
                onChange={(e) => change(() => setHandover((prev) => ({ ...prev, id: e.target.value })))}
                data-track="settings.assignment.handover.target.pick"
              >
                <option value="">
                  {handover.type === 'user' && directory.loading ? 'Loading people…' : 'Choose…'}
                </option>
                {/* The stored pointer whose row is gone — kept visible, like the
                    other two pickers, rather than redrawn as "unset". */}
                {handoverMissing ? (
                  <option value={handover.id}>
                    {handover.type === 'user'
                      ? 'A user no longer available'
                      : handover.type === 'role'
                        ? 'A role that no longer exists'
                        : 'A group that no longer exists'}
                  </option>
                ) : null}
                {handover.type === 'user'
                  ? handoverUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {userLabel(u)}
                      </option>
                    ))
                  : handover.type === 'role'
                    ? roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))
                    : groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                          {g.language === null ? '' : ` · ${g.language}`}
                          {` · ${g.activeMembers} active`}
                        </option>
                      ))}
              </Select>
              {handover.type === 'user' && !directory.loading && handoverUsers.length === 0 ? (
                <p className="mt-2 text-xs text-body">
                  {directory.unavailable
                    ? 'The user directory could not be read, so nobody can be nominated from here.'
                    : 'No active users to nominate.'}
                </p>
              ) : null}
              {handover.type === 'pool' && groups.length === 0 ? (
                <p className="mt-2 text-xs text-body">No groups exist yet, so there is no pool to nominate.</p>
              ) : null}
              {handoverMissing ? (
                <p role="alert" className="mt-2 text-xs text-error">
                  The {handover.type === 'pool' ? 'group' : handover.type} nominated here is gone or
                  inactive. New deals are already going to the Admin. Choose another, or set the rule
                  back to the Admin — saving it as it stands will be refused.
                </p>
              ) : null}
              {handoverGroup !== undefined && handoverGroup.activeMembers === 0 ? (
                <p role="alert" className="mt-2 text-xs text-error">
                  {handoverGroup.name} has no active members, so new deals go to the Admin instead.
                </p>
              ) : null}
            </div>
          ) : null}

          {!loading && loadError === null ? (
            <div className="rounded border border-border bg-background px-4 py-3">
              <p className="text-xs font-medium text-heading">As configured right now</p>
              <p className="mt-2 text-xs text-body">
                The next deal will be owned by{' '}
                {handover.type === '' || handover.id === '' ? (
                  <>
                    the <strong className="font-medium text-heading">Admin</strong>.
                  </>
                ) : handover.type === 'user' ? (
                  handoverUser ? (
                    <strong className="font-medium text-heading">{userLabel(handoverUser)}</strong>
                  ) : (
                    <>the Admin — the nominated user cannot be found.</>
                  )
                ) : handover.type === 'role' ? (
                  handoverRole ? (
                    <>
                      the next active <strong className="font-medium text-heading">{handoverRole.name}</strong>{' '}
                      in rotation.
                    </>
                  ) : (
                    <>the Admin — the nominated role cannot be found.</>
                  )
                ) : handoverGroup && handoverGroup.activeMembers > 0 ? (
                  <>
                    the next active member of{' '}
                    <strong className="font-medium text-heading">{handoverGroup.name}</strong> in
                    rotation.
                  </>
                ) : (
                  <>the Admin — the nominated group is empty or gone.</>
                )}{' '}
                Closed By is always the lead&apos;s owner at conversion, whatever this says.
              </p>
            </div>
          ) : null}

          <FieldError>{saveError}</FieldError>

          <div className="flex items-center gap-3 border-t border-border pt-6">
            <Button
              loading={busy}
              disabled={!dirty}
              onClick={save}
              data-track="settings.assignment.save.click"
            >
              {busy ? 'Saving…' : 'Save routing'}
            </Button>
            {dirty ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={discard}
                data-track="settings.assignment.discard.click"
              >
                Discard changes
              </Button>
            ) : null}
            {/* One line, three states, never two at once — unsaved beats
                saved, because it describes what is on screen. */}
            {dirty ? (
              <span className="text-xs text-body">
                Not saved yet — routing is still using the stored values, not what is on screen.
              </span>
            ) : saved ? (
              <span role="status" className="text-xs text-heading">
                Saved. Every record created from now on routes by these pointers; records already
                owned are untouched.
              </span>
            ) : null}
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
