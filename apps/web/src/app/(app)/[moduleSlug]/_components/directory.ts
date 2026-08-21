'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';

/**
 * The user directory as the assignment surfaces need it: a picker of people a
 * record can be handed to, and a map from an owner id to the name to print
 * instead of it.
 *
 * REDECLARED rather than imported from `@/lib/config/users`: that module
 * carries `import 'server-only'`, and even a type-only import puts it in the
 * bundler's resolution graph for a `'use client'` module. Same reasoning as
 * `TableRow` in the record table and the wire types on the roles screens.
 *
 * Every field is nullable because every field is HIDEABLE — a role whose
 * matrix hides `email` on the Profile module gets null for it, since a hidden
 * field never leaves the server. That is also why `unavailable` exists: an
 * actor with no view scope on the Profile module enumerates nobody, and the
 * honest answer is to say so rather than to draw an empty picker.
 */

/** The route's own ceiling (`USERS_PAGE_MAX`). Asking for more is refused. */
const DIRECTORY_TAKE = 200;

export interface DirectoryUser {
  id: string;
  fullName: string | null;
  email: string | null;
  isActive: boolean | null;
}

export interface Directory {
  /** Everyone the actor may enumerate, in the API's order. */
  users: DirectoryUser[];
  /** How many exist — `> users.length` when the cap truncated the answer. */
  total: number;
  loading: boolean;
  /** The read failed or returned nobody; the caller must not pretend it did. */
  unavailable: boolean;
}

const EMPTY: Directory = { users: [], total: 0, loading: false, unavailable: false };

/**
 * What to print for a user. Never the id when there is anything better, and
 * never a hardcoded "Unknown": an id at least resolves in the audit log.
 */
export function userLabel(user: DirectoryUser): string {
  return user.fullName ?? user.email ?? user.id;
}

/**
 * Users who may RECEIVE work. A deactivated account keeps its history
 * (invariant 4) and still owns the records it owned, but handing it a new one
 * is the same dead end as leaving the record unassigned — spec §5.5 moves work
 * OFF such a user, never onto one. The server proves this again inside the
 * assignment transaction; this only keeps them out of the picker.
 */
export function assignable(users: DirectoryUser[]): DirectoryUser[] {
  return users.filter((u) => u.isActive !== false);
}

/** id → name, for the columns and panels that store an id and show a person. */
export function nameMap(users: DirectoryUser[]): Map<string, string> {
  return new Map(users.map((u) => [u.id, userLabel(u)]));
}

/**
 * Fetch the directory, once, when `enabled` turns true.
 *
 * Gated on a flag rather than always running because most readers of a list
 * never open an owner picker: a module with no owner, or an actor who cannot
 * reassign, must not pay for a list nothing will draw.
 */
export function useDirectory(enabled: boolean): Directory {
  const [state, setState] = useState<Directory>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ ...EMPTY, loading: true });

    api<{ users: DirectoryUser[]; total: number }>(`/api/users?take=${DIRECTORY_TAKE}`)
      .then((res) => {
        if (cancelled) return;
        setState({
          users: res.users,
          total: res.total,
          loading: false,
          unavailable: res.users.length === 0,
        });
      })
      .catch(() => {
        if (cancelled) return;
        // A role that cannot enumerate users is a legitimate configuration,
        // not a fault — 403 and "nobody to show" mean the same thing to a
        // picker, so both land here and the caller says so in words.
        setState({ users: [], total: 0, loading: false, unavailable: true });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
