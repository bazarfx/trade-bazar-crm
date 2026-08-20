'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@crm/shared';
import { Button, FieldError, FieldLabel, Input } from '@/components/ui';

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
      <FieldLabel htmlFor="email">Email</FieldLabel>
      <Input
        id="email"
        type="email"
        autoComplete="username"
        autoFocus
        data-track="auth.login.email.input"
        aria-invalid={!!errors.email}
        {...register('email')}
      />
      <FieldError>{errors.email?.message}</FieldError>

      <FieldLabel htmlFor="password" className="mt-4">
        Password
      </FieldLabel>
      <Input
        id="password"
        type="password"
        autoComplete="current-password"
        data-track="auth.login.password.input"
        aria-invalid={!!errors.password}
        {...register('password')}
      />
      <FieldError>{errors.password?.message}</FieldError>

      {formError && (
        <p role="alert" className="mt-4 rounded bg-error/10 px-3 py-2 text-xs text-error">
          {formError}
        </p>
      )}

      <Button
        type="submit"
        loading={isSubmitting}
        data-track="auth.login.submit.click"
        className="mt-6 w-full"
      >
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
