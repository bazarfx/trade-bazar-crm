import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The workspace packages ship raw TypeScript (`main: ./src/index.ts`) so that
 * engines stay editable without a build step. Next must transpile them.
 */
const config: NextConfig = {
  reactStrictMode: true,
  // A stray lockfile above the repo makes Next guess the wrong workspace root.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@crm/shared', '@crm/core', '@crm/db', '@crm/records'],
  // Node-only packages that must not go through the bundler: bullmq loads Lua
  // scripts from disk at runtime, ioredis and exceljs both reach for node
  // built-ins, and a bundled copy of any of them fails only once it is called.
  serverExternalPackages: ['@prisma/client', 'bcryptjs', 'bullmq', 'ioredis', 'exceljs'],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // engines and route handlers both import Prisma; keep it out of the bundle
    optimizePackageImports: ['@crm/shared'],
  },

  /**
   * The workspace packages are Node-ESM correct: their relative imports carry
   * `.js` extensions even though the files on disk are `.ts`. That is what lets
   * the worker run them through tsx unchanged. Teach the bundler the same
   * mapping rather than stripping the extensions and breaking the worker.
   */
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default config;
