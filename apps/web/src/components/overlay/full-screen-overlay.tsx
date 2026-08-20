'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui';
import { useOverlayStack } from './overlay-context';

/**
 * THE overlay in this product. Every create/edit form, builder and review
 * queue opens through this component, full screen — there are no small modal
 * windows anywhere (spec + CLAUDE.md, UI rules). Escape and the scroll lock
 * live in OverlayProvider so they behave correctly when overlays nest.
 */
interface FullScreenOverlayProps {
  title: string;
  onClose: () => void;
  /** `module.screen` prefix; the close button emits `${trackPrefix}.overlay.close`. */
  trackPrefix: string;
  children: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function FullScreenOverlay({ title, onClose, trackPrefix, children }: FullScreenOverlayProps) {
  const stack = useOverlayStack();
  const panelRef = useRef<HTMLDivElement>(null);

  // The stack calls onClose from a document-level listener, which would
  // otherwise capture the closure from the mount render. A ref keeps it live.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Portals need a DOM; render nothing until the first client commit.
  const [host, setHost] = useState<HTMLElement | null>(null);

  // Whatever was focused when this overlay mounted — the trigger, or a control
  // inside the overlay below it when overlays stack.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Captured on the FIRST commit, which is the only moment it is still
    // correct: the portal renders on the NEXT commit, and by the time the
    // effect below runs the content has mounted and autofocused its first
    // field, so document.activeElement is already inside the overlay.
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHost(document.body);
  }, []);

  useEffect(() => {
    if (!host) return;
    const id = stack.push(() => onCloseRef.current());
    // Content that autofocuses a field has picked the better landing spot;
    // only take focus when nothing inside the panel claimed it.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      stack.pop(id);
      // Hand focus back to whatever opened the overlay — usually the button
      // the keyboard user was on. A trigger that unmounted with the overlay
      // cannot take it, and focus falls back to the document.
      openerRef.current?.focus();
    };
  }, [host, stack]);

  // Keep Tab inside the dialog; aria-modal alone does not trap real focus.
  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!host) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={trapTab}
      className="fixed inset-0 z-50 flex flex-col bg-background outline-none"
    >
      {/* White chrome over the canvas, as every framed screen draws it: the
          body below stays bg-background so a form reads as the page, not as a
          card floating on one. */}
      <header className="flex h-16 shrink-0 items-center justify-between gap-6 border-b border-border bg-surface px-6">
        {/* truncate: an overlay title carries an Admin-authored module or
            status name and has no length limit. */}
        <h2 className="min-w-0 truncate text-lg font-medium text-heading">{title}</h2>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onCloseRef.current()}
          aria-label="Close"
          data-track={`${trackPrefix}.overlay.close`}
        >
          Close
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>,
    host,
  );
}
