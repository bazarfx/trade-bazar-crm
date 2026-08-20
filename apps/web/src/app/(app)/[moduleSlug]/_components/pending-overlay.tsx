'use client';

import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';

/**
 * What every not-yet-built action on this screen opens.
 *
 * It exists so the buttons behave like the real ones from day one — full
 * screen, Escape to close, focus returned to the trigger, one `data-track`
 * name that will not change when the real slice lands underneath it. A modal
 * would have to be replaced; this only has to have its body filled in.
 */
export interface PendingOverlayProps {
  title: string;
  message: string;
  /** `module.screen`; the close button emits `${trackPrefix}.overlay.close`. */
  trackPrefix: string;
  onClose: () => void;
}

export function PendingOverlay({ title, message, trackPrefix, onClose }: PendingOverlayProps) {
  return (
    <FullScreenOverlay title={title} trackPrefix={trackPrefix} onClose={onClose}>
      <div className="mx-auto max-w-[1440px] px-8 py-10">
        <p className="max-w-prose text-sm text-body">{message}</p>
      </div>
    </FullScreenOverlay>
  );
}
