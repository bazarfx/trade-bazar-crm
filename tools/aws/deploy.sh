#!/bin/bash
# Deploy the CRM onto the test server from the S3 bundle.
# Run as root, via SSM Run Command (see README.md in this folder).
# Idempotent: re-running re-installs, re-migrates and restarts.
set -euo pipefail

REGION=ap-south-1
BUCKET=crm-test-deploy-010539085833
APP=/opt/crm/app
param() { aws ssm get-parameter --region "$REGION" --name "/crm/test/$1" --with-decryption --query Parameter.Value --output text; }
as_crm() { sudo -u crm -H env "$@"; }

test -f /var/lib/crm-user-data-done || { echo "first-boot setup has not finished yet"; exit 1; }

echo "== fetch bundle"
aws s3 cp "s3://$BUCKET/app.tar.gz" /tmp/app.tar.gz --region "$REGION" --only-show-errors
systemctl stop crm-web crm-worker 2>/dev/null || true
rm -rf "$APP.new" && mkdir -p "$APP.new"
tar -xzf /tmp/app.tar.gz -C "$APP.new"
rm -rf "$APP" && mv "$APP.new" "$APP"

echo "== env"
DB_HOST=$(param db-host)
APP_PW=$(param db-app-password)
HOST=$(cat /etc/crm-hostname)
umask 077
cat > "$APP/.env" <<EOF
DATABASE_URL="postgresql://crm_app:${APP_PW}@${DB_HOST}:5432/trade_bazar_crm?schema=public&sslmode=require&connection_limit=10&pool_timeout=20&connect_timeout=15"
DIRECT_URL="postgresql://crm_app:${APP_PW}@${DB_HOST}:5432/trade_bazar_crm?schema=public&sslmode=require"
REDIS_URL="redis://127.0.0.1:6379"
JWT_ACCESS_SECRET="$(param jwt-access-secret)"
JWT_REFRESH_SECRET="$(param jwt-refresh-secret)"
JWT_ACCESS_TTL="15m"
JWT_REFRESH_TTL="30d"
ARK_WEBHOOK_SECRET="$(param ark-webhook-secret)"
NEXT_PUBLIC_APP_URL="https://${HOST}"
LOGIN_DEFAULT_DOMAIN="tradebazar.local"
SEED_ADMIN_EMAIL="admin@tradebazar.local"
EOF
umask 022
ln -sfn ../../.env "$APP/apps/web/.env"
chown -R crm:crm "$APP"

echo "== npm ci"
# The committed lockfile can lag package.json (Vercel runs `npm install`, which
# papers over it). Prefer the exact lock; fall back rather than fail the deploy.
as_crm bash -lc "cd $APP && npm ci --no-audit --no-fund" || {
  echo "!! package-lock.json is out of sync with package.json - falling back to npm install"
  as_crm bash -lc "cd $APP && npm install --no-audit --no-fund"
}

echo "== database bootstrap (idempotent)"
# pg_trgm is created by the master user: crm_app has no CREATE on the database.
MASTER_PW=$(param db-master-password)
{
  echo "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
  sed "s/REPLACE_ME/${APP_PW}/" "$APP/packages/db/prisma/bootstrap.sql"
  echo "ALTER ROLE crm_app WITH PASSWORD '${APP_PW}';"
} > /tmp/bootstrap.sql
chmod 600 /tmp/bootstrap.sql
(cd "$APP" && ./node_modules/.bin/prisma db execute \
  --url "postgresql://postgres:${MASTER_PW}@${DB_HOST}:5432/trade_bazar_crm?sslmode=require" \
  --file /tmp/bootstrap.sql)
shred -u /tmp/bootstrap.sql

echo "== migrations"
as_crm bash -lc "cd $APP && npm run db:deploy"

echo "== seed"
as_crm SEED_ADMIN_PASSWORD="$(param seed-admin-password)" bash -lc "cd $APP && npm run db:seed"
if [ ! -f /opt/crm/.demo-seeded ]; then
  as_crm ALLOW_DEMO_SEED_REMOTE=1 bash -lc "cd $APP && npm run db:seed:demo"
  touch /opt/crm/.demo-seeded
fi

echo "== build"
as_crm NODE_ENV=production NODE_OPTIONS=--max-old-space-size=1536 bash -lc "cd $APP && npm run build --workspace=apps/web"

echo "== start"
systemctl daemon-reload
systemctl enable --now crm-web crm-worker
sleep 10
curl -s -o /dev/null -w 'local /login -> HTTP %{http_code}\n' http://127.0.0.1:3000/login || true
systemctl is-active crm-web crm-worker caddy redis6
echo "URL: https://$HOST"
