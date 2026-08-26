'use client';

/**
 * Copy to the clipboard and SAY WHETHER IT WORKED.
 *
 * The async Clipboard API is undefined on plain-http origins (a call-floor
 * deployment behind a LAN address is exactly that) and rejects when the
 * document loses focus mid-click. The buttons this backs guard one-time
 * credential displays — a Copy that silently did nothing there costs an
 * account lock-out, so the caller must get a true/false to show, and the
 * legacy execCommand path is worth keeping as the http fallback.
 */
export async function copyText(value: string): Promise<boolean> {
  if (value === '') return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }

  try {
    const holder = document.createElement('textarea');
    holder.value = value;
    // Off-screen, not display:none — a hidden textarea cannot be selected.
    holder.style.position = 'fixed';
    holder.style.left = '-9999px';
    holder.setAttribute('readonly', '');
    document.body.appendChild(holder);
    holder.select();
    const ok = document.execCommand('copy');
    holder.remove();
    return ok;
  } catch {
    return false;
  }
}
