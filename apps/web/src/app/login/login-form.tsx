'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@crm/shared';

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginInput) {
    setFormError(null);

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setFormError(body?.error ?? 'Sign in failed. Try again.');
      return;
    }

    router.replace(redirectTo);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-heading">
        Email
      </label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        autoFocus
        data-track="auth.login.email.input"
        aria-invalid={!!errors.email}
        className="mb-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-heading outline-none focus:border-primary"
        {...register('email')}
      />
      {errors.email && (
        <p role="alert" className="mb-3 text-xs text-error">
          {errors.email.message}
        </p>
      )}

      <label htmlFor="password" className="mb-1.5 mt-4 block text-sm font-medium text-heading">
        Password
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        data-track="auth.login.password.input"
        aria-invalid={!!errors.password}
        className="mb-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-heading outline-none focus:border-primary"
        {...register('password')}
      />
      {errors.password && (
        <p role="alert" className="mb-3 text-xs text-error">
          {errors.password.message}
        </p>
      )}

      {formError && (
        <p role="alert" className="mt-4 rounded bg-error/10 px-3 py-2 text-xs text-error">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        data-track="auth.login.submit.click"
        className="mt-6 w-full rounded bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
