import { NextResponse } from 'next/server';
import { layoutSaveSchema, LAYOUT_TARGETS, type LayoutTargetValue } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { ConfigError } from '@/lib/config/service';
import { getLayout, saveLayout } from '@/lib/config/layouts';

/** ?target= is required and closed — anything else is a caller bug, not a 500. */
function parseTarget(req: Request): LayoutTargetValue {
  const target = new URL(req.url).searchParams.get('target');
  if (!target || !(LAYOUT_TARGETS as readonly string[]).includes(target)) {
    throw new ConfigError('target must be FORM or DETAIL', 400, 'VALIDATION');
  }
  return target as LayoutTargetValue;
}

export const GET = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const target = parseTarget(req);
  const roleId = new URL(req.url).searchParams.get('roleId');
  const { spec, source } = await getLayout(principal, slug, target, roleId || null);
  return NextResponse.json({ spec, source });
});

export const PUT = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const input = await parseBody(req, layoutSaveSchema);
  const layout = await saveLayout(principal, slug, input);
  return NextResponse.json({ layout });
});
