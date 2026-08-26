-- Access tokens are stateless JWTs, so revoking refresh tokens alone leaves a
-- stolen access cookie working until it expires (up to JWT_ACCESS_TTL). A
-- password reset stamps this column and the session layer refuses any access
-- token issued before it — "signed out everywhere" becomes true the moment
-- the reset commits, not fifteen minutes later.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "credentialsChangedAt" TIMESTAMP(3);
