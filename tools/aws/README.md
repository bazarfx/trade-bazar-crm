# AWS test environment

A low-cost test deployment in **ap-south-1 (Mumbai)**, account `010539085833`.
Everything is tagged `Project=crm-test`.

| Piece | Resource | Notes |
|---|---|---|
| Web + worker + Redis + Caddy | EC2 `t4g.small` `i-0f31e28ef78199ee1` | Amazon Linux 2023 arm64, 20 GB gp3, CPU credits `standard` (no surplus charges), 2 GB swap |
| Postgres 17 | RDS `db.t4g.micro` `crm-test-db` | Single-AZ, 20 GB gp3, private (no public IP), 1-day backups, encrypted, deletion protection on |
| Secrets | SSM Parameter Store `/crm/test/*` | SecureString, standard tier (free) |
| Code bundle | S3 `crm-test-deploy-010539085833` | `git archive HEAD` + `deploy.sh` |
| Access | SSM Session Manager | No SSH key, port 22 closed. Only 80/443 are open |
| Auto-stop | EventBridge Scheduler | EC2 + RDS stop daily at **23:00 IST** |
| Billing alert | AWS Budgets `crm-test-monthly-usage` | Emails bazarfxcrm@gmail.com at $5 / $15 / $30 of usage, measured before credits |

The database accepts connections only from the web server's security group.
The app is served at `https://<public-ip-with-dashes>.sslip.io` with a Let's
Encrypt certificate; the address changes on every stop/start.

## Daily use

```powershell
powershell -File tools\aws\start.ps1    # start both, prints today's URL
powershell -File tools\aws\stop.ps1     # stop both (storage-only cost)
powershell -File tools\aws\deploy.ps1   # ship the committed code (git HEAD)
```

Admin login: `admin@tradebazar.local` (or just `admin`). The password is in SSM:

```powershell
aws ssm get-parameter --region ap-south-1 --name /crm/test/seed-admin-password --with-decryption --query Parameter.Value --output text
```

Shell on the server (needs the Session Manager plugin for the AWS CLI):

```powershell
aws ssm start-session --region ap-south-1 --target i-0f31e28ef78199ee1
```

Logs: `journalctl -u crm-web -u crm-worker -f`, deploy log `/var/log/crm-deploy.log`.

## Files

| File | Purpose |
|---|---|
| `user-data.sh` | First boot: swap, Node 22, Redis, Caddy, systemd units |
| `deploy.sh` | On the server: fetch bundle, write `.env` from SSM, `npm ci`, bootstrap role, `db:deploy`, seed, build, restart |
| `deploy.ps1` / `start.ps1` / `stop.ps1` | Local helpers |
| `teardown.ps1` | Deletes everything except the budget. Irreversible |
| `policies/`, `schedules/` | IAM and scheduler definitions used at creation |

## Cost

Roughly $30/month if left running 24/7, ~$10-12/month at working hours only.
While stopped: storage only (~$4/month). AWS restarts a stopped RDS instance
by itself after 7 days — the nightly schedule stops it again.
