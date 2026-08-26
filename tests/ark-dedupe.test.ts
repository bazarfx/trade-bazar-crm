/**
 * The deposit dedupe key — the thing standing between an ARK redelivery and
 * a client's total being counted twice.
 *
 * Every case here is one that has already been wrong once. The two worth
 * naming: the key must survive the LIVE mapping, which names neither a
 * reference nor a timestamp (the first version of this fix returned null
 * there and protected nothing); and a timestamp the parse INVENTED must never
 * key a deposit, because it differs on every delivery and would look like
 * protection while providing none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, depositDedupeKey, parseArkEvent, type ArkMapping } from '@crm/shared';

const fingerprint = (raw: unknown): string =>
  createHash('sha256').update(canonicalJson(raw), 'utf8').digest('hex');

/** The mapping the client's real ARK source carries today. */
const LIVE_MAPPING = {
  rules: [
    { source: 'mobile', concept: 'phone', transform: 'phone' },
    { source: 'language', concept: 'language', transform: 'trim' },
    { source: 'account_no', concept: 'accountNumber', transform: 'trim' },
    { source: 'name', concept: 'name', transform: 'trim' },
    { source: 'deposit', concept: 'depositAmount', transform: 'number' },
  ],
} as unknown as ArkMapping;

const BODY = {
  mobile: '9876543210',
  language: 'Hindi',
  account_no: 'ARK-5006',
  name: 'Priya Sharma',
  deposit: '50000',
};

const parse = (raw: unknown, mapping: ArkMapping = LIVE_MAPPING) =>
  parseArkEvent(raw, mapping, fingerprint(raw));

test('the live mapping produces a key at all', () => {
  assert.notEqual(parse(BODY).dedupeKey, null);
});

test('a redelivery of the same body computes the same key', () => {
  assert.equal(parse(BODY).dedupeKey, parse(BODY).dedupeKey);
});

test('a body re-serialised in a different key order still matches', () => {
  const reordered = { deposit: '50000', name: 'Priya Sharma', account_no: 'ARK-5006', language: 'Hindi', mobile: '9876543210' };
  assert.equal(parse(reordered).dedupeKey, parse(BODY).dedupeKey);
});

test('a genuinely different deposit keys differently and still banks', () => {
  assert.notEqual(parse({ ...BODY, deposit: '75000' }).dedupeKey, parse(BODY).dedupeKey);
});

test('an account-only event carries no key', () => {
  assert.equal(parse({ ...BODY, deposit: '0' }).dedupeKey, null);
});

test('an INVENTED timestamp never keys a deposit', () => {
  // No depositedAt rule, so the parse defaults it to now(). If that value
  // ever reached the key, two deliveries would differ and protect nothing.
  assert.ok(!(parse(BODY).dedupeKey ?? '').startsWith('fp:'));
});

test('a mapped timestamp is preferred over the raw body', () => {
  const mapping = { rules: [...LIVE_MAPPING.rules, { source: 'ts', concept: 'depositedAt', transform: 'date' }] } as unknown as ArkMapping;
  const key = parse({ ...BODY, ts: '2026-08-25T09:15:30Z' }, mapping).dedupeKey;
  assert.ok(key?.startsWith('fp:'));
});

test("ARK's own reference is preferred over everything", () => {
  const mapping = { rules: [...LIVE_MAPPING.rules, { source: 'txn', concept: 'externalId', transform: 'none' }] } as unknown as ArkMapping;
  assert.equal(parse({ ...BODY, txn: 'TXN-9' }, mapping).dedupeKey, 'ark:TXN-9');
});

test('the three key sources cannot collide with each other', () => {
  const at = new Date('2026-08-25T00:00:00Z');
  const prefixes = [
    depositDedupeKey({ externalId: 'x', depositAmount: 1 }),
    depositDedupeKey({ accountNumber: 'x', depositAmount: 1, depositedAt: at }),
    depositDedupeKey({ depositAmount: 1, bodyFingerprint: 'x' }),
  ].map((k) => (k ?? '').split(':')[0]);
  assert.deepEqual(prefixes, ['ark', 'fp', 'raw']);
});

test('1000 and 1000.00 are one deposit, not two', () => {
  const at = new Date('2026-08-25T09:00:00Z');
  assert.equal(
    depositDedupeKey({ accountNumber: 'a', depositAmount: 1000, depositedAt: at }),
    depositDedupeKey({ accountNumber: 'a', depositAmount: 1000.0, depositedAt: at }),
  );
});
