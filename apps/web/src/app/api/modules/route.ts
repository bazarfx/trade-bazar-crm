import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { listModules } from '@/lib/config/catalog';

export const GET = guarded(async () => {
  const modules = await listModules();
  return NextResponse.json({ modules });
});
