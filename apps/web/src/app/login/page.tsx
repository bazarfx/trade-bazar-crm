import type { Metadata } from 'next';
import { Panel, PanelBody } from '@/components/ui';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · Trade Bazar CRM' };

/**
 * Accounts are created by an Admin. There is no signup link, no password-reset
 * self-service and no tenant picker — by design.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  // Only ever accept a same-origin path back, never an absolute URL.
  const redirectTo = next?.startsWith('/') && !next.startsWith('//') ? next : '/leads';

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-title font-medium text-heading">Trade Bazar CRM</h1>
          <p className="mt-1 text-sm text-body">Sign in to continue.</p>
        </div>

        <Panel>
          <PanelBody>
            <LoginForm redirectTo={redirectTo} />
          </PanelBody>
        </Panel>

        <p className="mt-6 text-center text-xs text-body">
          Accounts are created by your administrator.
        </p>
      </div>
    </main>
  );
}
