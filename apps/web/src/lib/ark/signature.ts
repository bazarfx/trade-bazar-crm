/**
 * Webhook signature verification — the pure half.
 *
 * Deliberately free of `server-only`, Prisma and Next: this is arithmetic
 * over bytes and a string comparison, and keeping it that way means it can be
 * exercised directly by a test rather than only through an HTTP request
 * against a configured source. `./receive.ts` owns the database read that
 * supplies the credentials and calls this.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THE SCHEME IS DATA.
 *
 * ARK's authentication scheme is still unspecified. The original design put
 * the header and algorithm in a shared constant, which meant switching
 * verification on was a deploy — and a deploy that switched it on for EVERY
 * source at once, so the first partner to start signing would break every
 * partner that had not. Both faults are the same fault: a customer-visible
 * option that needs a code change (CLAUDE.md, the prime directive).
 *
 * So the scheme travels per source, and the three values below are the ones
 * that actually differ between real schemes: which header carries the digest,
 * how it is encoded, and what prefix it wears. The constant remains as the
 * fallback for a source configured before any of this existed.
 * ═══════════════════════════════════════════════════════════════════════
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ARK_SIGNATURE_ALGORITHMS,
  ARK_SIGNATURE_FORMATS,
  ARK_SIGNATURE_SLOT,
  type ArkSignatureAlgorithm,
  type ArkSignatureFormat,
} from '@crm/shared';

/** Our algorithm names to Node's. A lookup rather than string surgery, so
 *  adding one to the union is a compile error until it is mapped here. */
const HMAC_ALGORITHMS: Record<ArkSignatureAlgorithm, string> = {
  'hmac-sha256': 'sha256',
  'hmac-sha512': 'sha512',
};

/** A source's verification settings: the secret and the scheme it is used
 *  with. Read in `./receive.ts` and passed here; never logged, never in a DTO. */
export interface ArkSignatureCredentials {
  signingSecret: string | null;
  signatureHeader: string | null;
  signatureAlgorithm: string | null;
  signatureFormat: string | null;
  signaturePrefix: string | null;
}

export type SignatureCheck =
  /** no scheme configured: accept, and say it was not verified */
  | { ok: true; verified: false }
  /** configured, and the body checked out */
  | { ok: true; verified: true }
  /** configured, and the body did NOT check out */
  | { ok: false; reason: string };

/**
 * Verify one request. Runs over the RAW text, never a parsed object — a
 * signature is over bytes, and re-serialising JSON changes them.
 *
 * Every failure mode below fails CLOSED. A half-configured source (a scheme
 * named with no secret behind it) and an unrecognised algorithm both refuse
 * rather than fall back to accepting: "verification is on" must never be able
 * to mean "verifying nothing", which is the one outcome worse than having no
 * verification at all, because it is the one nobody checks.
 */
export function verifyWebhookSignature(
  headerValue: (name: string) => string | null,
  rawText: string,
  source: ArkSignatureCredentials,
): SignatureCheck {
  // The SOURCE's own scheme first; the global slot is only the fallback for a
  // source configured before per-source settings existed.
  const header = source.signatureHeader ?? ARK_SIGNATURE_SLOT.header;
  const rawAlgorithm = source.signatureAlgorithm ?? ARK_SIGNATURE_SLOT.algorithm;

  // ANY of the three set means somebody INTENDED this source to verify, so
  // the question "is verification on" is answered before the question "is it
  // complete". Testing the header and algorithm first would fail OPEN on a
  // half-configuration — a source with a secret and a header but no algorithm
  // would accept every unsigned call, silently, while its screen and its
  // operator both believed it was armed. That asymmetry is the dangerous one:
  // the secretless case refuses everything and is noticed within minutes,
  // this one is never noticed at all.
  //
  // Fails CLOSED and names the missing piece, so the fix is obvious.
  const configured = Boolean(header) || Boolean(rawAlgorithm) || Boolean(source.signingSecret);
  if (!configured) {
    // Genuinely unconfigured: the unguessable token remains the gate, which
    // is where this started and where an untouched source still sits.
    return { ok: true, verified: false };
  }

  if (!header) return { ok: false, reason: 'This source has no signature header configured' };
  if (!rawAlgorithm) {
    return { ok: false, reason: 'This source has no signature algorithm configured' };
  }
  if (!source.signingSecret) {
    return { ok: false, reason: 'This source has no signing secret configured' };
  }

  // A stored algorithm is a string from the database, so it is validated
  // rather than trusted: a typo must not silently downgrade the source.
  const algorithm = ARK_SIGNATURE_ALGORITHMS.find((a) => a === rawAlgorithm);
  if (!algorithm) {
    return { ok: false, reason: `Unsupported signature algorithm "${rawAlgorithm}"` };
  }
  const format: ArkSignatureFormat =
    ARK_SIGNATURE_FORMATS.find((f) => f === source.signatureFormat) ?? 'hex';

  const presented = headerValue(header);
  if (!presented) return { ok: false, reason: `Missing ${header} header` };

  // The prefix is notation, not signature — "sha256=abc…" carries the same
  // digest as "abc…". Stripped so a scheme that wears one is configured by
  // naming it rather than by editing code.
  const prefix = source.signaturePrefix ?? '';
  let offered = presented.trim();
  if (prefix && offered.toLowerCase().startsWith(prefix.toLowerCase())) {
    offered = offered.slice(prefix.length).trim();
  }

  const digest = createHmac(HMAC_ALGORITHMS[algorithm], source.signingSecret)
    .update(rawText, 'utf8')
    .digest(format);

  // Hex is case-insensitive notation; base64 is not, so only hex is folded.
  const expected = format === 'hex' ? digest.toLowerCase() : digest;
  const candidate = format === 'hex' ? offered.toLowerCase() : offered;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  // Length first: `timingSafeEqual` throws on a length mismatch, and a length
  // difference is not a secret worth protecting.
  const matches = a.length === b.length && timingSafeEqual(a, b);
  return matches
    ? { ok: true, verified: true }
    : { ok: false, reason: ARK_SIGNATURE_SLOT.failureMessage };
}
