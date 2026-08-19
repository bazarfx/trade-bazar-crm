import { NextResponse } from 'next/server';
import { LAYOUT_TARGETS, type LayoutTargetValue } from '@crm/shared';
import { guarded } from '@/lib/api';
import { ConfigError } from '@/lib/config/service';
import { resolveModuleLayout } from '@/lib/config/layouts';

export const GET = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const target = new URL(req.url).searchParams.get('target');
  if (!target || !(LAYOUT_TARGETS as readonly string[]).includes(target)) {
    throw new ConfigError('target must be FORM or DETAIL', 400, 'VALIDATION');
  }
  const sections = await resolveModuleLayout(principal, slug, target as LayoutTargetValue);
  return NextResponse.json({ sections });
});
