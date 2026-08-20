'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

/**
 * Signing out is one behaviour with two skins — a bordered button on the
 * "no modules enabled" page, a nav row in the app shell. The behaviour lives
 * here so the shell cannot end up with a logout that forgets to revoke the
 * refresh token or forgets `router.refresh()` (without which the server
 * components of the signed-in shell stay cached after the cookies are gone).
 */
export function useSignOut(): { signOut: () => void; busy: boolean } {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const signOut = useCallback(() => {
    setBusy(true);
    void (async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.replace('/login');
      router.refresh();
    })();
  }, [router]);

  return { signOut, busy };
}

export function SignOutButton() {
  const { signOut, busy } = useSignOut();

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      data-track="auth.shell.signout.click"
      className="rounded border border-border px-3 py-1.5 text-sm text-heading disabled:opacity-60"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
