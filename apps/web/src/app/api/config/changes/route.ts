import { NextResponse } from 'next/server';
import { CONFIG_TYPES, type ConfigType } from '@crm/shared';
import { guarded } from '@/lib/api';
import { ConfigError } from '@/lib/config/service';
import { listChanges } from '@/lib/config/changes';

export const GET = guarded(async (req, principal) => {
  const params = new URL(req.url).searchParams;

  const configType = params.get('configType') ?? undefined;
  if (configType && !(CONFIG_TYPES as readonly string[]).includes(configType)) {
    throw new ConfigError(`Unknown configType "${configType}"`, 400, 'VALIDATION');
  }

  const limitRaw = params.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new ConfigError('limit must be a positive integer', 400, 'VALIDATION');
  }

  const changes = await listChanges(principal, {
    configType: configType as ConfigType | undefined,
    configId: params.get('configId') ?? undefined,
    limit,
  });
  return NextResponse.json({ changes });
});
