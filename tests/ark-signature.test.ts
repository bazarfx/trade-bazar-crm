/**
 * Webhook signature verification.
 *
 * The cases that matter are the ones where a mistake fails OPEN, because a
 * source that accepts everything while its screen says "verifying" is worse
 * than one with no verification at all — nobody checks it. Every partial
 * configuration below must refuse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ARK_SIGNATURE_REJECTED, isSignatureRejection } from '@crm/shared';
import { verifyWebhookSignature } from '../apps/web/src/lib/ark/signature';

const BODY = '{"account_no":"ARK-5006","deposit":50000}';
const SECRET = 'shared-secret';
const headers = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()] ?? null;
const digest = (algo: 'sha256' | 'sha512', enc: 'hex' | 'base64', body = BODY, secret = SECRET) =>
  createHmac(algo, secret).update(body, 'utf8').digest(enc);

const NOTHING = {
  signingSecret: null,
  signatureHeader: null,
  signatureAlgorithm: null,
  signatureFormat: null,
  signaturePrefix: null,
};
const CONFIGURED = {
  ...NOTHING,
  signingSecret: SECRET,
  signatureHeader: 'x-ark-signature',
  signatureAlgorithm: 'hmac-sha256',
  signatureFormat: 'hex',
};

test('an untouched source accepts, and says it did not verify', () => {
  assert.deepEqual(verifyWebhookSignature(headers({}), BODY, NOTHING), { ok: true, verified: false });
});

test('a valid signature is accepted', () => {
  const r = verifyWebhookSignature(headers({ 'x-ark-signature': digest('sha256', 'hex') }), BODY, CONFIGURED);
  assert.deepEqual(r, { ok: true, verified: true });
});

test('a tampered body is refused', () => {
  const r = verifyWebhookSignature(headers({ 'x-ark-signature': digest('sha256', 'hex') }), `${BODY} `, CONFIGURED);
  assert.equal(r.ok, false);
});

test('a signature made with the wrong secret is refused', () => {
  const forged = digest('sha256', 'hex', BODY, 'not-the-secret');
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': forged }), BODY, CONFIGURED).ok, false);
});

test('a missing header is refused', () => {
  assert.equal(verifyWebhookSignature(headers({}), BODY, CONFIGURED).ok, false);
});

test('a truncated signature is refused rather than throwing', () => {
  const short = digest('sha256', 'hex').slice(0, 12);
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': short }), BODY, CONFIGURED).ok, false);
});

// ── the fail-open cases ──────────────────────────────────────────────────
// Each of these once accepted every unsigned call while looking configured.

test('a header and a secret but NO algorithm refuses', () => {
  const half = { ...NOTHING, signatureHeader: 'x-ark-signature', signingSecret: SECRET };
  assert.equal(verifyWebhookSignature(headers({}), BODY, half).ok, false);
});

test('an algorithm and a secret but NO header refuses', () => {
  const half = { ...NOTHING, signatureAlgorithm: 'hmac-sha256', signingSecret: SECRET };
  assert.equal(verifyWebhookSignature(headers({}), BODY, half).ok, false);
});

test('a complete scheme with NO secret refuses', () => {
  assert.equal(
    verifyWebhookSignature(headers({ 'x-ark-signature': digest('sha256', 'hex') }), BODY, { ...CONFIGURED, signingSecret: null }).ok,
    false,
  );
});

test('an unrecognised algorithm refuses instead of downgrading', () => {
  assert.equal(
    verifyWebhookSignature(headers({ 'x-ark-signature': digest('sha256', 'hex') }), BODY, { ...CONFIGURED, signatureAlgorithm: 'hmac-md5' }).ok,
    false,
  );
});

// ── encodings and notation ───────────────────────────────────────────────

test('hex is compared case-insensitively; base64 is not', () => {
  const hex = digest('sha256', 'hex');
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': hex.toUpperCase() }), BODY, CONFIGURED).ok, true);

  const b64cfg = { ...CONFIGURED, signatureFormat: 'base64' };
  const b64 = digest('sha256', 'base64');
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': b64 }), BODY, b64cfg).ok, true);
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': b64.toUpperCase() }), BODY, b64cfg).ok, false);
});

test('a configured prefix is stripped, and its absence is tolerated', () => {
  const cfg = { ...CONFIGURED, signaturePrefix: 'sha256=' };
  const hex = digest('sha256', 'hex');
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': `sha256=${hex}` }), BODY, cfg).ok, true);
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': hex }), BODY, cfg).ok, true);
});

test('the header name is matched case-insensitively, as HTTP requires', () => {
  const cfg = { ...CONFIGURED, signatureHeader: 'X-Ark-Signature' };
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': digest('sha256', 'hex') }), BODY, cfg).ok, true);
});

test('sha512 is supported', () => {
  const cfg = { ...CONFIGURED, signatureAlgorithm: 'hmac-sha512' };
  assert.equal(verifyWebhookSignature(headers({ 'x-ark-signature': digest('sha512', 'hex') }), BODY, cfg).ok, true);
});

// ── a forgery must not be replayable ─────────────────────────────────────

test('a signature refusal is marked, and benign refusals are not', () => {
  assert.ok(isSignatureRejection(`${ARK_SIGNATURE_REJECTED}: Signature verification failed`));
  assert.ok(!isSignatureRejection('An account event for an existing deal carried no deposit'));
  assert.ok(!isSignatureRejection(null));
});
