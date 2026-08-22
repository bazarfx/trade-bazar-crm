import { redirect } from 'next/navigation';
import { getPrincipal } from '@/lib/auth/session';
import { coreModuleStorages } from '@/lib/records/list';
import { ArkManager, type ConversionModules } from './_components/ark-manager';

/**
 * The two modules an event's products live in, found the way the conversion
 * service finds them: the module whose table declares a Closed By column and
 * a deposit ledger is the deal side; the module whose rows it inherits its
 * timeline from is the lead side. Null when no such pair exists — the event
 * log then draws no record links rather than guessing a path.
 */
async function conversionModules(): Promise<ConversionModules | null> {
  const storages = await coreModuleStorages();
  const target = storages.find(
    (m) => m.shape.closedByColumn !== null && m.shape.ledger !== null && m.shape.inheritsTimelineFrom !== null,
  );
  if (!target?.shape.inheritsTimelineFrom) return null;
  const parentType = target.shape.inheritsTimelineFrom.entityType;
  const source = storages.find((m) => m.shape.entityType === parentType);
  return source ? { leadSlug: source.ref.slug, dealSlug: target.ref.slug } : null;
}

/**
 * ARK Terminal (spec §7): the webhook sources ARK posts account events into,
 * and the only conversion path this product has. There is no manual Convert
 * button anywhere — a lead becomes a deal when an account event with a
 * deposit arrives here, and at no other moment.
 *
 * THE HONEST STATE OF THIS SLICE: the ARK webhook spec does not exist yet —
 * no field names, no auth, no retry contract. Exactly as the campaign intake
 * screen does for Integrately, this screen states that rather than papering
 * over it. The payload mapping is an Admin-edited space; every event is
 * stored raw before parsing and is replayable; signature verification is a
 * documented slot. What is NOT a space is everything behind the mapping:
 * the match order, the four outcomes, the conversion, the handover rule and
 * the deposit ledger are built and waiting.
 *
 * The list is read client-side from `/api/ark-sources`: which sources are
 * ARK's is the conversion slice's own knowledge, and encoding it here as a
 * Prisma query would be a second copy to keep in step.
 */
export default async function ArkSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; event?: string }>;
}) {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  // UX gate only — the ARK API asserts again on every read and write. The
  // same door as campaign intake: a webhook source is a webhook source.
  const canManage =
    principal.actor.isAdmin || principal.permissions.specials.has('MANAGE_CAMPAIGNS');
  if (!canManage) redirect('/');

  // A deposit row links straight to the event it was read from; the manager
  // opens that source's log on that event.
  const [{ source, event }, modules] = await Promise.all([searchParams, conversionModules()]);
  const focus = source && event ? { sourceId: source, eventId: event } : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-medium text-heading">ARK Terminal</h1>
        <p className="mt-1 max-w-3xl text-sm text-body">
          ARK posts a webhook for every account created and every deposit made. Each source below
          is one URL it posts into. Every payload is stored raw before anything reads it, matched
          against deals first and leads second by phone, and acted on in one of four ways — with
          every step written to the record&apos;s timeline. This is the only way a lead converts.
        </p>
      </div>

      <ArkManager focus={focus} modules={modules} />
    </div>
  );
}
