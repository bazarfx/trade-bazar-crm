'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@/components/ui';

/**
 * A read-only value with a Copy button — the intake URL's one chance to be
 * copied. Clipboard access can be denied (permissions policy, http origin),
 * so the value is also selectable text: the fallback is the user's own ⌘C,
 * not a silent failure.
 */
export interface CopyFieldProps {
  value: string;
  track: string;
}

export function CopyField({ value, track }: CopyFieldProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  function copy() {
    navigator.clipboard
      .writeText(value)
      .then(() => setState('copied'))
      .catch(() => setState('failed'))
      .finally(() => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), 2500);
      });
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Intake URL"
        className="font-mono"
        data-track={`${track}.field`}
      />
      <Button variant="secondary" size="sm" onClick={copy} data-track={track}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select & copy manually' : 'Copy'}
      </Button>
    </div>
  );
}
