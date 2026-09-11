#!/bin/bash
# First-boot setup for the CRM test server — Amazon Linux 2023, arm64 (t4g).
# Installs the runtime only. The app itself is installed by deploy.sh.
set -euxo pipefail

# ── swap: `next build` does not fit in 2 GB RAM next to Redis and the OS ──
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── packages: Redis for BullMQ, bound to localhost by default ──
dnf install -y git tar xz redis6
systemctl enable --now redis6

# ── Node 22 from nodejs.org, checksum-verified ──
cd /tmp
BASE=https://nodejs.org/dist/latest-v22.x
curl -fsSL "$BASE/SHASUMS256.txt" -o SHASUMS256.txt
TARBALL=$(awk '/linux-arm64\.tar\.xz$/ {print $2}' SHASUMS256.txt)
curl -fsSLO "$BASE/$TARBALL"
grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$TARBALL" -C /usr/local --strip-components=1
node --version

# ── Caddy: HTTPS via Let's Encrypt, reverse proxy to Next on :3000 ──
curl -fsSL 'https://caddyserver.com/api/download?os=linux&arch=arm64' -o /usr/local/bin/caddy
chmod 755 /usr/local/bin/caddy
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
mkdir -p /etc/caddy

# ── app user ──
id crm >/dev/null 2>&1 || useradd --system --home-dir /opt/crm --create-home --shell /bin/bash crm

# ── hostname: <public-ip>.sslip.io, recomputed every boot (the IP changes on stop/start) ──
cat > /usr/local/bin/crm-hostname <<'EOF'
#!/bin/bash
set -euo pipefail
TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
HOST="${IP//./-}.sslip.io"
echo "$HOST" > /etc/crm-hostname
# Next 15 builds middleware redirects from its own listen address
# (http://localhost:3000), ignoring Host / X-Forwarded-Host, so rewrite them here.
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000 {
		header_down Location ^https?://localhost:3000 https://$HOST
	}
}
CADDY
EOF
chmod 755 /usr/local/bin/crm-hostname

cat > /etc/systemd/system/crm-hostname.service <<'EOF'
[Unit]
Description=Write this boot's Caddyfile from the public IP
After=network-online.target
Wants=network-online.target
Before=caddy.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/crm-hostname

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network-online.target crm-hostname.service
Requires=crm-hostname.service

[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

# ── app services: enabled by deploy.sh once the app exists ──
cat > /etc/systemd/system/crm-web.service <<'EOF'
[Unit]
Description=CRM web (Next.js)
After=network-online.target redis6.service

[Service]
User=crm
WorkingDirectory=/opt/crm/app/apps/web
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=768
ExecStart=/opt/crm/app/node_modules/.bin/next start -H 127.0.0.1 -p 3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/crm-worker.service <<'EOF'
[Unit]
Description=CRM worker (BullMQ)
After=network-online.target redis6.service

[Service]
User=crm
WorkingDirectory=/opt/crm/app/apps/worker
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=384
ExecStart=/opt/crm/app/node_modules/.bin/tsx --env-file=/opt/crm/app/.env src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now crm-hostname caddy
touch /var/lib/crm-user-data-done
