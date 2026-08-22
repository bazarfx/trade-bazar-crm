'use client';

import { useEffect, useMemo, useState } from 'react';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Avatar, Button, Checkbox, Chip, Input, Panel, PanelBody, PanelHeader } from '@/components/ui';
import { demoAvatarFor } from '@/components/demo-avatar';
import { api } from '@/lib/client-api';
import { messageOf, Notice } from '../profile-shared';
import { personLabel, type GroupDto, type GroupMemberDto, type PickerUser } from './types';

/**
 * A group's members — spec §5.3's "add/remove member controls", made literal.
 *
 * A FULL-SCREEN overlay, not a pop-up: it is an authoring surface with a list
 * and a picker side by side, which is the class of screen CLAUDE.md keeps at
 * full size (the file draws no Profile screens to measure against). Two
 * panels: who is in the group, with a Remove per row; and who could be, with
 * a checkbox each and one Add. Both write through the members routes and
 * re-read the server's answer rather than patching local state — the group
 * is the backbone of assignment, and a screen that shows a membership the
 * server refused would be lying about where the next lead goes.
 */

/** The users route's own ceiling (`USERS_PAGE_MAX`); asking for more is refused. */
const PICKER_TAKE = 200;

export interface GroupMembersOverlayProps {
  slug: string;
  group: GroupDto;
  /** A membership changed — the list behind this overlay recounts. */
  onChanged: () => void;
  onClose: () => void;
}

function matches(user: { fullName: string | null; email: string | null }, needle: string): boolean {
  if (needle === '') return true;
  const n = needle.toLowerCase();
  return (user.fullName ?? '').toLowerCase().includes(n) || (user.email ?? '').toLowerCase().includes(n);
}

export function GroupMembersOverlay({ slug, group, onChanged, onClose }: GroupMembersOverlayProps) {
  const [members, setMembers] = useState<GroupMemberDto[]>([]);
  const [users, setUsers] = useState<PickerUser[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [needle, setNeedle] = useState('');
  /** the user ids a write is in flight for — disables just those rows */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const track = `${slug}.groups.members`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api<{ members: GroupMemberDto[] }>(`/api/groups/${group.id}/members`),
      api<{ users: PickerUser[]; total: number }>(`/api/users?take=${PICKER_TAKE}`),
    ])
      .then(([m, u]) => {
        if (cancelled) return;
        setMembers(m.members);
        setUsers(u.users);
        setUsersTotal(u.total);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageOf(err, 'Could not load this group.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [group.id]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);

  /**
   * Who can be ADDED: active users not already in. A deactivated account keeps
   * its history and its memberships, but handing it a new one is the same dead
   * end as leaving a lead unassigned — spec §5.5 moves work OFF such a user.
   */
  const candidates = useMemo(
    () => users.filter((u) => u.isActive !== false && !memberIds.has(u.id) && matches(u, needle.trim())),
    [users, memberIds, needle],
  );

  async function write(method: 'POST' | 'DELETE', userIds: string[]) {
    if (userIds.length === 0) return;
    setError(null);
    setBusy(new Set(userIds));
    try {
      const res = await api<{ members: GroupMemberDto[] }>(`/api/groups/${group.id}/members`, {
        method,
        body: JSON.stringify({ userIds }),
      });
      setMembers(res.members);
      setSelected((cur) => {
        const next = new Set(cur);
        for (const id of userIds) next.delete(id);
        return next;
      });
      onChanged();
    } catch (err) {
      setError(messageOf(err, method === 'POST' ? 'Could not add those members.' : 'Could not remove that member.'));
    } finally {
      setBusy(new Set());
    }
  }

  const activeMembers = members.filter((m) => m.isActive !== false).length;

  return (
    <FullScreenOverlay title={`Members — ${group.name}`} onClose={onClose} trackPrefix={track}>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-8">
        <p className="text-sm text-body">
          {group.language
            ? `Campaign leads in ${group.language} round-robin across this group's active members.`
            : 'This group serves no language, so leads reach it only when it is the nominated default pool.'}{' '}
          Deactivated members stay listed but are skipped by the round-robin.
        </p>

        {error !== null ? (
          <Notice tone="error" onDismiss={() => setError(null)} track={`${track}.error.dismiss`}>
            {error}
          </Notice>
        ) : null}

        {/* items-start: each panel scrolls its own list; neither stretches to
            the other's height, so a group of two beside a directory of two
            hundred stays readable. */}
        <div className="flex items-start gap-6">
          <Panel className="flex min-w-0 flex-1 flex-col">
            <PanelHeader
              title={`Members — ${activeMembers} active of ${members.length}`}
              className="px-4 py-3"
            />
            <div className="max-h-[60vh] overflow-y-auto">
              {loading ? (
                <p className="px-4 py-6 text-sm text-body">Loading…</p>
              ) : members.length === 0 ? (
                <p className="px-4 py-6 text-sm text-body">
                  Nobody is in this group yet. Leads routed here have no one to land on — add
                  members from the right.
                </p>
              ) : (
                <ul>
                  {members.map((m) => {
                    const src = demoAvatarFor(m.userId);
                    const name = personLabel(m, m.userId);
                    return (
                      <li
                        key={m.userId}
                        // The file's row: 45 tall, 1px rule, pad 10/12, the
                        // 24px Display Picture then the text.
                        className="flex h-[45px] items-center gap-3 border-b border-border px-3 text-sm"
                      >
                        <Avatar {...(src === undefined ? {} : { src })} name={name} size={24} />
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="truncate text-heading" title={name}>
                            {name}
                          </span>
                          {m.email !== null && m.email !== name ? (
                            <span className="hidden truncate text-xs text-body md:inline" title={m.email}>
                              {m.email}
                            </span>
                          ) : null}
                        </div>
                        {m.roleName !== null ? <Chip tone="neutral">{m.roleName}</Chip> : null}
                        {m.isActive === false ? (
                          <Chip tone="warning">Inactive</Chip>
                        ) : (
                          <Chip tone="success">Active</Chip>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void write('DELETE', [m.userId])}
                          disabled={busy.has(m.userId)}
                          loading={busy.has(m.userId)}
                          data-track={`${track}.remove`}
                          className="text-error hover:bg-error/10"
                        >
                          Remove
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Panel>

          <Panel className="flex min-w-0 flex-1 flex-col">
            <PanelHeader
              title="Add members"
              className="px-4 py-3"
              actions={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void write('POST', [...selected])}
                  disabled={selected.size === 0 || busy.size > 0}
                  loading={busy.size > 0 && selected.size > 0}
                  data-track={`${track}.add`}
                >
                  Add {selected.size > 0 ? `${selected.size} ` : ''}selected
                </Button>
              }
            />
            <PanelBody className="border-b border-border px-4 py-3">
              <Input
                type="search"
                value={needle}
                onChange={(e) => setNeedle(e.target.value)}
                placeholder="Search by name or email"
                aria-label="Search users to add"
                data-track={`${track}.search`}
              />
              {usersTotal > users.length ? (
                // Honest about the cap: the search above narrows what was
                // fetched, and cannot reach past it.
                <p className="mt-2 text-xs text-muted">
                  Showing the first {users.length} of {usersTotal} users.
                </p>
              ) : null}
            </PanelBody>
            <div className="max-h-[50vh] overflow-y-auto">
              {loading ? (
                <p className="px-4 py-6 text-sm text-body">Loading…</p>
              ) : candidates.length === 0 ? (
                <p className="px-4 py-6 text-sm text-body">
                  {needle.trim() === ''
                    ? 'Every active user is already in this group.'
                    : 'No active user matches that search.'}
                </p>
              ) : (
                <ul>
                  {candidates.map((u) => {
                    const src = demoAvatarFor(u.id);
                    const name = personLabel(u, u.id);
                    return (
                      <li
                        key={u.id}
                        className="flex h-[45px] items-center gap-3 border-b border-border px-3 text-sm"
                      >
                        <Checkbox
                          checked={selected.has(u.id)}
                          disabled={busy.size > 0}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setSelected((cur) => {
                              const next = new Set(cur);
                              if (checked) next.add(u.id);
                              else next.delete(u.id);
                              return next;
                            });
                          }}
                          data-track={`${track}.pick`}
                          label={
                            <span className="flex items-center gap-2">
                              <Avatar {...(src === undefined ? {} : { src })} name={name} size={24} />
                              <span className="truncate text-heading" title={name}>
                                {name}
                              </span>
                              {u.email !== null && u.email !== name ? (
                                <span className="hidden truncate text-xs text-body md:inline" title={u.email}>
                                  {u.email}
                                </span>
                              ) : null}
                            </span>
                          }
                        />
                        {u.roleName !== null ? (
                          <Chip tone="neutral" className="ml-auto">
                            {u.roleName}
                          </Chip>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </FullScreenOverlay>
  );
}
