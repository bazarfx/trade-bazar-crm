'use client';

import { useState } from 'react';
import {
  ARK_SIGNATURE_ALGORITHMS,
  ARK_SIGNATURE_FORMATS,
  arkSignatureConfigSchema,
  arkSigningSecretSchema,
  type ArkSignatureAlgorithm,
  type ArkSignatureFormat,
} from '@crm/shared';
import {
  Button,
  Chip,
  FieldError,
  FieldLabel,
  Input,
  Popup,
  PopupFooter,
  Select,
  type ChipTone,
} from '@/components/ui';
import { api } from '@/lib/client-api';
import type { ArkSourceRow } from './ark-manager';

/**
 * How one ARK source authenticates its caller — as DATA on the source, which
 * is the whole point of this screen existing.
 *
 * ARK's signing scheme is still unspecified. The first design put the header
 * and the algorithm in a compile-time constant, which made switching
 * verification on a DEPLOY, and a deploy that switched it on for every source
 * at once. CLAUDE.md's prime directive forbids exactly that: "if adding a
 * customer-visible option would require a code change, a migration or a
 * deploy, the design is wrong." So the scheme lives on the source and this
 * pop-up is where an Admin fills it in — the day ARK says how it signs, and
 * without anybody being called.
 *
 * TWO WRITES, NOT ONE, and deliberately so:
 *  - the SCHEME (header, algorithm, format, prefix) is ordinary configuration
 *    and goes through `PATCH /api/ark-sources/<id>`, which snapshots it into
 *    the append-only ConfigChangeLog with before/after;
 *  - the SECRET is a credential and goes through its own
 *    `PUT /api/ark-sources/<id>/signing-secret`, so it can never ride along
 *    in a payload that gets snapshotted into a log nothing may ever UPDATE.
 * The server never returns a stored secret, so this screen never shows one —
 * only whether one is set.
 *
 * SURFACE: a 1015 pop-up, not a full-screen overlay. CLAUDE.md's rewritten UI
 * rule gives full screen to the big authoring surfaces the Figma file does not
 * draw (record form, field builder, layout editor, roles matrix, review
 * queue). This is a bounded four-field form plus one credential — the file's
 * multi-field pop-up ("Create New Fields", 1015) is the shape it matches.
 * `ArkMappingOverlay` stays full-screen because it authors an unbounded rule
 * list against a reference payload; this authors four values.
 */

/** The scheme as the DTO carries it: strings from the database, never trusted
 *  as members of the unions until they are matched against them. */
export interface ArkSignatureView {
  header: string | null;
  algorithm: string | null;
  format: string | null;
  prefix: string | null;
  /** whether a secret is set — never the secret, which nothing can read back */
  hasSecret: boolean;
}

/**
 * The four states a source can actually be in, derived through the SAME
 * branches `verifyWebhookSignature` takes (`apps/web/src/lib/ark/signature.ts`).
 * If this table and that function ever disagree, the chip is lying about
 * whether the endpoint is open — so each case names the branch it mirrors.
 *
 *  - `off`        — no header and no algorithm: the verifier returns
 *                   `{ ok: true, verified: false }` and the unguessable URL
 *                   token stays the only gate. Where every source starts.
 *  - `incomplete` — one of the two named but not the other: the verifier still
 *                   returns "not configured" and ACCEPTS. Looks armed, is not.
 *  - `refusing`   — both named, no secret behind them: the verifier fails
 *                   CLOSED and every call is refused. Recoverable, but nothing
 *                   gets through until it is.
 *  - `enforcing`  — header, algorithm and secret all present: digests are
 *                   computed over the raw body and compared in constant time.
 *
 * The verifier reads `source.signatureHeader ?? ARK_SIGNATURE_SLOT.header`;
 * both slot values are null and are the pre-per-source fallback, so the
 * source's own two values are the whole answer here.
 */
export type ArkSignatureState = 'off' | 'incomplete' | 'refusing' | 'enforcing';

export function arkSignatureState(signature: ArkSignatureView | null | undefined): ArkSignatureState {
  // Defensive against a response that predates the signature block: no scheme
  // read is the same as no scheme set, which is the honest "token only".
  if (!signature) return 'off';
  const header = signature.header !== null && signature.header !== '';
  const algorithm = signature.algorithm !== null && signature.algorithm !== '';
  if (!header && !algorithm) return 'off';
  if (!header || !algorithm) return 'incomplete';
  return signature.hasSecret ? 'enforcing' : 'refusing';
}

/** How each state reads in a row. Keyed on the union so a state added above
 *  without a chip is a type error rather than a blank cell. */
export const ARK_SIGNATURE_STATE: Record<
  ArkSignatureState,
  { label: string; tone: ChipTone; title: string }
> = {
  off: {
    label: 'Token only',
    tone: 'neutral',
    title:
      'No signature scheme is configured. The unguessable token in the webhook URL is the only authentication this source has — which is where every source starts, and what ARK has been given today.',
  },
  incomplete: {
    label: 'Not enforcing',
    tone: 'warning',
    title:
      'A header or an algorithm is set, but not both — so nothing is verified and every call is still accepted. Name both, or clear both.',
  },
  refusing: {
    label: 'No secret — refusing',
    tone: 'error',
    title:
      'A scheme is configured but no signing secret backs it, so verification fails closed: EVERY call is refused. The payloads are still stored and replayable. Set the secret, or clear the scheme.',
  },
  enforcing: {
    label: 'Verifying',
    tone: 'success',
    title:
      'Every call is verified against this source’s secret before it is enqueued. A call whose digest does not match is stored and marked IGNORED, never processed.',
  },
};

/** The algorithms, said in words. Keyed on the union so adding one to
 *  `ARK_SIGNATURE_ALGORITHMS` without a label is a compile error. */
const ALGORITHM_LABEL: Record<ArkSignatureAlgorithm, string> = {
  'hmac-sha256': 'HMAC SHA-256',
  'hmac-sha512': 'HMAC SHA-512',
};

const FORMAT_LABEL: Record<ArkSignatureFormat, string> = {
  hex: 'Hexadecimal',
  base64: 'Base64',
};

/** A stored string is validated, never cast: a value written before an option
 *  was removed must render as "none chosen", not as a phantom option. */
function asAlgorithm(value: string | null): ArkSignatureAlgorithm | '' {
  return ARK_SIGNATURE_ALGORITHMS.find((a) => a === value) ?? '';
}

function asFormat(value: string | null): ArkSignatureFormat | '' {
  return ARK_SIGNATURE_FORMATS.find((f) => f === value) ?? '';
}

export interface ArkSignatureOverlayProps {
  source: ArkSourceRow;
  onSaved: () => void;
  onClose: () => void;
}

export function ArkSignatureOverlay({ source, onSaved, onClose }: ArkSignatureOverlayProps) {
  const stored: ArkSignatureView = source.signature ?? {
    header: null,
    algorithm: null,
    format: null,
    prefix: null,
    hasSecret: false,
  };

  const [header, setHeader] = useState(stored.header ?? '');
  const [algorithm, setAlgorithm] = useState<ArkSignatureAlgorithm | ''>(asAlgorithm(stored.algorithm));
  // The verifier falls back to hex when no format is stored, so an unset
  // source opens showing what it would actually do rather than a blank.
  const [format, setFormat] = useState<ArkSignatureFormat | ''>(asFormat(stored.format) || 'hex');
  const [prefix, setPrefix] = useState(stored.prefix ?? '');

  /** Typed, never loaded: the server has no way to return the stored value. */
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  /** An explicit intent, because an EMPTY box must not silently clear a
   *  working secret — that would take the endpoint down on a stray save. */
  const [clearing, setClearing] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wantsScheme = header.trim() !== '' && algorithm !== '';
  const halfScheme = (header.trim() !== '') !== (algorithm !== '');
  const settingSecret = !clearing && secret.trim() !== '';
  /** What `hasSecret` will be once this save lands. */
  const secretAfter = clearing ? false : settingSecret || stored.hasSecret;

  const draftState: ArkSignatureState = !wantsScheme
    ? halfScheme
      ? 'incomplete'
      : 'off'
    : secretAfter
      ? 'enforcing'
      : 'refusing';

  async function save() {
    // Both refusals below are states the server would accept and the receiver
    // would then honour literally — one by opening the door, one by welding it
    // shut. There is no reason to let a save leave this pop-up in either when
    // both halves are on screen together.
    if (halfScheme) {
      setError(
        'A header and an algorithm are both needed. With only one of them nothing is verified and every call is still accepted — name both to switch verification on, or clear both to leave the URL token as the only gate.',
      );
      return;
    }
    if (wantsScheme && !secretAfter) {
      setError(
        'This scheme has no signing secret behind it, so the receiver would refuse EVERY call from ARK. Set the shared secret below, or clear the header and algorithm to switch verification off.',
      );
      return;
    }

    // Off means off: a format or a prefix left behind on a source with no
    // scheme is noise in the change log and reads as a half-configuration
    // next time somebody opens this.
    const signature = wantsScheme
      ? {
          header: header.trim(),
          algorithm,
          format: format === '' ? 'hex' : format,
          prefix: prefix.trim() === '' ? null : prefix.trim(),
        }
      : { header: null, algorithm: null, format: null, prefix: null };

    // The SAME schema the route parses with — `packages/shared` defines it
    // once, so a length or a blank caught here is caught for the same reason
    // the server would catch it, never a second opinion.
    const parsedScheme = arkSignatureConfigSchema.safeParse(signature);
    if (!parsedScheme.success) {
      setError(parsedScheme.error.issues[0]?.message ?? 'These signature settings are not valid.');
      return;
    }
    const secretValue = clearing ? '' : secret.trim();
    const parsedSecret = arkSigningSecretSchema.safeParse({ signingSecret: secretValue });
    if (!parsedSecret.success) {
      setError(parsedSecret.error.issues[0]?.message ?? 'That signing secret is not valid.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // ORDER IS THE POINT. A source is only safe in two of the four states,
      // and the unsafe one — a scheme with no secret — refuses every real
      // call. So the write that would create it goes LAST:
      //   turning on  → secret first, then the scheme;
      //   turning off → scheme first, then the secret.
      // Either way the source is never momentarily armed and secretless
      // between two requests, which on a live endpoint is dropped account
      // events rather than a cosmetic flicker.
      if (settingSecret) {
        await api<{ source: unknown }>(`/api/ark-sources/${source.id}/signing-secret`, {
          method: 'PUT',
          body: JSON.stringify({ signingSecret: secretValue }),
        });
      }
      await api<{ source: unknown }>(`/api/ark-sources/${source.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ signature: parsedScheme.data }),
      });
      if (clearing) {
        await api<{ source: unknown }>(`/api/ark-sources/${source.id}/signing-secret`, {
          method: 'PUT',
          body: JSON.stringify({ signingSecret: '' }),
        });
      }
      setBusy(false);
      onSaved();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'The signature settings could not be saved.');
    }
  }

  /** Mid-request the pop-up refuses to close: one of two writes may already
   *  have landed, and closing would hide which. */
  function guardedClose() {
    if (!busy) onClose();
  }

  const current = ARK_SIGNATURE_STATE[arkSignatureState(stored)];
  const next = ARK_SIGNATURE_STATE[draftState];

  return (
    <Popup
      title={`Signature verification — ${source.name}`}
      width={1015}
      open
      onClose={guardedClose}
      trackPrefix="settings.ark.signature"
      footer={
        <PopupFooter
          trackPrefix="settings.ark.signature"
          cancel={{ label: 'Cancel', onClick: guardedClose, disabled: busy }}
          next={{
            label: busy ? 'Saving…' : 'Save settings',
            onClick: () => void save(),
            disabled: busy,
          }}
        />
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-body">Right now:</span>
            <Chip tone={current.tone} title={current.title}>
              {current.label}
            </Chip>
            {draftState !== arkSignatureState(stored) ? (
              <>
                <span className="text-xs text-body">→ after saving:</span>
                <Chip tone={next.tone} title={next.title}>
                  {next.label}
                </Chip>
              </>
            ) : null}
          </div>

          <p className="mt-4 text-sm text-body">
            A signed webhook proves the call came from ARK and not from anyone who has seen the
            URL. ARK computes a digest of the raw body with a secret you both hold and sends it in
            a header; this server recomputes it and compares. Until both a header and an algorithm
            are named below, none of that happens and the token in the URL is the only
            authentication this source has.
          </p>

          <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FieldLabel htmlFor="ark-signature-header">Header</FieldLabel>
              <Input
                id="ark-signature-header"
                value={header}
                maxLength={100}
                placeholder="x-ark-signature"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setHeader(e.target.value);
                  setError(null);
                }}
                data-track="settings.ark.signature.header.input"
              />
              <p className="mt-1 text-xs text-muted">
                The header ARK puts the digest in. Case does not matter.
              </p>
            </div>

            <div>
              <FieldLabel htmlFor="ark-signature-algorithm">Algorithm</FieldLabel>
              <Select
                id="ark-signature-algorithm"
                value={algorithm}
                onChange={(e) => {
                  setAlgorithm(asAlgorithm(e.target.value));
                  setError(null);
                }}
                data-track="settings.ark.signature.algorithm.select"
              >
                <option value="">Not configured</option>
                {ARK_SIGNATURE_ALGORITHMS.map((a) => (
                  <option key={a} value={a}>
                    {ALGORITHM_LABEL[a]}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted">
                How the digest is computed over the raw body.
              </p>
            </div>

            <div>
              <FieldLabel htmlFor="ark-signature-format">Encoding</FieldLabel>
              <Select
                id="ark-signature-format"
                value={format}
                onChange={(e) => {
                  setFormat(asFormat(e.target.value));
                  setError(null);
                }}
                data-track="settings.ark.signature.format.select"
              >
                {ARK_SIGNATURE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABEL[f]}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted">
                How the digest is written on the wire. Hexadecimal if unsure — it is what the
                receiver assumes.
              </p>
            </div>

            <div className="sm:col-span-2">
              <FieldLabel htmlFor="ark-signature-prefix">Value prefix (optional)</FieldLabel>
              <Input
                id="ark-signature-prefix"
                value={prefix}
                maxLength={20}
                placeholder="sha256="
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setPrefix(e.target.value);
                  setError(null);
                }}
                data-track="settings.ark.signature.prefix.input"
              />
              <p className="mt-1 text-xs text-muted">
                Some senders wear a label on the value —{' '}
                <code className="rounded bg-subtle px-1 font-mono">sha256=abc…</code>. Name it here
                and it is stripped before the comparison; it is notation, not signature.
              </p>
            </div>
          </div>

          {/* The credential. Its own section, its own request, its own route —
              never in the payload the change log snapshots. */}
          <div className="mt-6 border-t border-border pt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel htmlFor="ark-signature-secret">Shared signing secret</FieldLabel>
              <div className="flex shrink-0 items-center gap-3">
                {stored.hasSecret ? (
                  <Chip tone="success">A secret is set</Chip>
                ) : (
                  <Chip tone="neutral">No secret set</Chip>
                )}
                <button
                  type="button"
                  className="text-xs font-medium text-body hover:text-heading"
                  onClick={() => setShowSecret((v) => !v)}
                  data-track="settings.ark.signature.secret.toggle"
                >
                  {showSecret ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <Input
              id="ark-signature-secret"
              type={showSecret ? 'text' : 'password'}
              value={secret}
              maxLength={200}
              disabled={clearing}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                stored.hasSecret
                  ? 'Leave blank to keep the secret already set'
                  : 'Paste the secret ARK gave you'
              }
              onChange={(e) => {
                setSecret(e.target.value);
                setError(null);
              }}
              data-track="settings.ark.signature.secret.input"
            />
            <p className="mt-1 text-xs text-muted">
              Write-only. The server stores it and never hands it back, so it cannot be shown here
              — only whether one is set. Losing your copy means asking ARK for the secret again,
              not reading it off this screen.
            </p>

            {stored.hasSecret ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setClearing((v) => !v);
                    setSecret('');
                    setError(null);
                  }}
                  data-track="settings.ark.signature.secret.clear"
                >
                  {clearing ? 'Keep the current secret' : 'Clear the secret'}
                </Button>
                {clearing ? (
                  <span className="text-xs text-warning">
                    The secret will be removed when you save. Clear the header and algorithm in the
                    same save, or this source will refuse every call.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <FieldError>{error}</FieldError>
        </div>

        {/* What switching this on actually means — the honest note, same voice
            as the mapping overlay's. */}
        <aside className="flex flex-col gap-4">
          <div className="rounded-lg border border-warning bg-surface px-5 py-4">
            <p className="text-sm font-medium text-heading">
              ARK has not published its signing scheme.
            </p>
            <p className="mt-1 text-sm text-body">
              No header name, algorithm or encoding has been guessed in code — these four values
              are the space left for the answer. Fill them in from ARK&apos;s own documentation,
              not from a guess: a wrong header, a wrong encoding or a wrong secret all produce the
              same result, which is that every real call is refused.
            </p>
          </div>

          <div className="rounded border border-border bg-background px-4 py-3 text-xs text-body">
            <p className="font-medium text-heading">What a refused call does</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                The raw payload is stored <strong className="font-medium text-heading">first</strong>,
                before the signature is even checked — a forged call is evidence, and a real one
                misconfigured is an account event nobody may lose.
              </li>
              <li>
                The event is settled <strong className="font-medium text-heading">IGNORED</strong>{' '}
                with the reason on it and ARK is answered 401. Nothing is processed, nothing is
                banked twice.
              </li>
              <li>
                A refused call <strong className="font-medium text-heading">cannot be replayed</strong>.
                Replay does not re-check signatures, so allowing it would put a forged payload one
                click from creating a lead and banking a deposit. Its body stays on the event for
                evidence either way.
              </li>
              <li>
                So get the header and secret right before you switch this on. If real calls are
                being refused, correct the settings here and ask ARK to send them again — the
                refused copies stay on the Events log for comparison.
              </li>
            </ul>
          </div>

          <div className="rounded border border-border bg-background px-4 py-3 text-xs text-body">
            <p className="font-medium text-heading">The three states</p>
            <ul className="mt-2 space-y-2">
              {(['off', 'refusing', 'enforcing'] as const).map((state) => (
                <li key={state} className="flex flex-col gap-1">
                  <Chip tone={ARK_SIGNATURE_STATE[state].tone} className="self-start">
                    {ARK_SIGNATURE_STATE[state].label}
                  </Chip>
                  <span>{ARK_SIGNATURE_STATE[state].title}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </Popup>
  );
}
