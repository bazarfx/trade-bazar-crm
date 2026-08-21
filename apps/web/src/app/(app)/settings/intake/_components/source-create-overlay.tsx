'use client';

import { useState } from 'react';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, FieldError, FieldLabel, Input, Select } from '@/components/ui';
import { api } from '@/lib/client-api';
import { CopyField } from './copy-field';
import type { ModuleOption } from './intake-manager';

/**
 * Create one webhook source: a name and the module its leads land in.
 *
 * The body matches `webhookSourceCreateSchema` in `packages/shared` — the
 * module travels as a SLUG and the server resolves it, generates the secret
 * token and answers with the one copy of the full intake URL that will ever
 * exist (only the token's hash is stored). That is why the success state
 * lives INSIDE this overlay: closing it is the user asserting they have the
 * URL, and there is no second chance to show it.
 */

export interface CreatedSource {
  name: string;
  intakeUrl: string;
}

export interface SourceCreateOverlayProps {
  modules: ModuleOption[];
  onCreated: (created: CreatedSource) => void;
  onClose: () => void;
}

export function SourceCreateOverlay({ modules, onCreated, onClose }: SourceCreateOverlayProps) {
  const [name, setName] = useState('');
  const [moduleSlug, setModuleSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedSource | null>(null);

  function submit() {
    if (name.trim() === '') {
      setError('Name the source — “Facebook Lead Ads via Integrately”, say.');
      return;
    }
    if (moduleSlug === '') {
      setError('Choose the module incoming leads should be created in.');
      return;
    }
    setBusy(true);
    setError(null);

    api<{ source: { name: string }; intakeUrl: string }>('/api/webhook-sources', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), moduleSlug }),
    })
      .then((res) => {
        setBusy(false);
        setResult({ name: res.source.name, intakeUrl: res.intakeUrl });
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : 'The source could not be created.');
      });
  }

  /** Closing after a create still hands the URL up — the manager keeps it on
   *  screen until the user dismisses it, so an accidental Escape here does
   *  not destroy the only copy. */
  function finish() {
    if (result !== null) onCreated(result);
    else onClose();
  }

  return (
    <FullScreenOverlay title="New intake source" onClose={finish} trackPrefix="settings.intake.create">
      <div className="mx-auto max-w-2xl px-8 py-8">
        {result === null ? (
          <>
            <p className="text-sm text-body">
              A source is one webhook URL a campaign platform posts into. Create one per platform
              or per campaign feed — each keeps its own payload mapping and its own event log, so
              a shape change on one platform never breaks another.
            </p>

            <FieldLabel htmlFor="intake-source-name" className="mt-6" required>
              Name
            </FieldLabel>
            <Input
              id="intake-source-name"
              value={name}
              autoFocus
              maxLength={100}
              placeholder="Facebook Lead Ads via Integrately"
              onChange={(e) => setName(e.target.value)}
              data-track="settings.intake.create.name.input"
            />

            <FieldLabel htmlFor="intake-source-module" className="mt-5" required>
              Module
            </FieldLabel>
            <Select
              id="intake-source-module"
              value={moduleSlug}
              onChange={(e) => setModuleSlug(e.target.value)}
              data-track="settings.intake.create.module.select"
            >
              <option value="">Choose a module…</option>
              {modules.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.labelPlural}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-body">
              Incoming payloads become records in this module, assigned through the same
              round-robin as every other lead.
            </p>

            <FieldError>{error}</FieldError>

            <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
              <Button loading={busy} onClick={submit} data-track="settings.intake.source.create">
                Create source
              </Button>
              <Button variant="secondary" onClick={onClose} data-track="settings.intake.create.cancel">
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-heading">“{result.name}” is ready.</p>
            <p className="mt-2 text-sm text-body">
              This is the intake URL — and the ONLY time the server can show it, because it stores
              just a hash of the token inside it. Copy it now and paste it into the campaign
              platform as the webhook destination. Lose it and you create a new source, not
              recover this one.
            </p>
            <div className="mt-4">
              <CopyField value={result.intakeUrl} track="settings.intake.source.url.copy" />
            </div>
            <p className="mt-4 text-sm text-body">
              Integrately is not connected yet. When the first real payload arrives it will appear
              in this source&apos;s Events list — open it there, read its shape, fill in the
              mapping, then replay it.
            </p>
            <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
              <Button onClick={finish} data-track="settings.intake.create.done">
                Done
              </Button>
            </div>
          </>
        )}
      </div>
    </FullScreenOverlay>
  );
}
