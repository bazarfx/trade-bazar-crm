'use client';

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';

/**
 * One stack for every full-screen overlay in the app. The stack — not each
 * overlay — owns the two global side effects, because with nested overlays
 * neither can be decided locally:
 *
 *  - the body scroll lock (`body[data-overlay-open]`, read by globals.css)
 *    must hold until the LAST overlay closes, not flicker off when a nested
 *    one does;
 *  - Escape must close only the TOP overlay, however deep the stack is.
 */
interface OverlayEntry {
  id: number;
  onClose: () => void;
}

interface OverlayStack {
  /** Register an open overlay; returns the id to `pop` on unmount. */
  push: (onClose: () => void) => number;
  pop: (id: number) => void;
}

const OverlayContext = createContext<OverlayStack | null>(null);

// Module-level so ids stay unique across overlay remounts within the session.
let nextOverlayId = 1;

export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const stack = useRef<OverlayEntry[]>([]);

  const value = useMemo<OverlayStack>(() => {
    const sync = () => {
      // globals.css matches the literal 'true' — depth > 0 is what it means.
      if (stack.current.length > 0) document.body.dataset.overlayOpen = 'true';
      else delete document.body.dataset.overlayOpen;
    };
    return {
      push(onClose) {
        const id = nextOverlayId++;
        stack.current.push({ id, onClose });
        sync();
        return id;
      },
      pop(id) {
        stack.current = stack.current.filter((e) => e.id !== id);
        sync();
      },
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const top = stack.current[stack.current.length - 1];
      if (!top) return;
      e.preventDefault();
      top.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

export function useOverlayStack(): OverlayStack {
  const ctx = useContext(OverlayContext);
  if (!ctx) {
    throw new Error(
      'FullScreenOverlay must render inside <OverlayProvider> — it is mounted by the app shell layout.',
    );
  }
  return ctx;
}
