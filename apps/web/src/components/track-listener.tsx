'use client';

import { useEffect } from 'react';

/**
 * The ONE interaction listener. Components never instrument themselves — they
 * carry a `data-track="module.screen.element.action"` attribute and this
 * delegated listener picks the interaction up, so instrumentation cannot be
 * forgotten component by component.
 *
 * Events are buffered and flushed in batches; one request per click at
 * ~3.6M interactions/month would be a denial of service against ourselves.
 */
interface TrackEvent {
  target: string;
  route: string;
  clientTs: number;
}

const FLUSH_EVERY_MS = 5_000;
const FLUSH_AT_COUNT = 25;

/**
 * Click alone would make every `.input`, `.select` and `.toggle` name dead for
 * anyone driving the app from the keyboard — a select changed with the arrow
 * keys never produces a click. One handler serves all three so a new event
 * type can never grow its own divergent copy of the buffering rules.
 */
const TRACKED_EVENTS = ['click', 'change', 'submit'] as const;

/** A pointer on a checkbox fires click AND change: one gesture, one log row. */
const DEDUPE_MS = 100;

export function TrackListener() {
  useEffect(() => {
    let buffer: TrackEvent[] = [];

    const flush = () => {
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      // TODO(day 28): POST /api/logs/batch — route → BullMQ → monthly partition.
      console.debug('[track]', batch);
    };

    // Only the last one is held, and it is dropped on unmount — a detached
    // node cannot be retained for longer than the next tracked interaction.
    let last: { el: Element; target: string; ts: number } | null = null;

    const record = (e: Event) => {
      const el = e.target instanceof Element ? e.target.closest('[data-track]') : null;
      const target = el?.getAttribute('data-track');
      if (!el || !target) return;
      const clientTs = Date.now();
      const isRepeat =
        last !== null && last.el === el && last.target === target && clientTs - last.ts < DEDUPE_MS;
      if (isRepeat) return;
      last = { el, target, ts: clientTs };
      buffer.push({ target, route: window.location.pathname, clientTs });
      if (buffer.length >= FLUSH_AT_COUNT) flush();
    };

    // Capture phase: a component calling stopPropagation must not be able to
    // silently punch a hole in the interaction log. Non-bubbling events reach
    // document on capture too, which is why one registration covers them all.
    for (const type of TRACKED_EVENTS) document.addEventListener(type, record, true);
    const timer = window.setInterval(flush, FLUSH_EVERY_MS);
    // Whatever is buffered when the tab goes away still gets flushed.
    window.addEventListener('pagehide', flush);

    return () => {
      for (const type of TRACKED_EVENTS) document.removeEventListener(type, record, true);
      window.clearInterval(timer);
      window.removeEventListener('pagehide', flush);
      last = null;
      flush();
    };
  }, []);

  return null;
}
