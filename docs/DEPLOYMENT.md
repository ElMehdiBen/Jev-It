# Production deployment

This setup runs Jev-It behind Caddy with automatic HTTPS. The Node application and MongoDB have no published host ports; only HTTP and HTTPS are exposed. MongoDB is isolated on an internal Docker network and uses separate root and application credentials.

## VM requirements

- A Linux VM with Docker Engine and the Docker Compose plugin.
- A domain whose A/AAAA record points to the VM.
- Inbound TCP ports 80 and 443, plus UDP 443, allowed by the firewall.
- Google OAuth credentials whose authorized redirect URI is `https://YOUR_DOMAIN/api/auth/google/callback`.

For a small installation, start with at least 2 vCPU, 2 GB RAM, and enough persistent disk for MongoDB and Docker images.

## First deployment

Clone the repository and enter it:

```bash
git clone https://github.com/ElMehdiBen/Jev-It.git
cd Jev-It
cp .env.production.example .env.production
chmod 600 .env.production
```

Generate two different database passwords:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Paste them into `MONGO_ROOT_PASSWORD` and `MONGO_APP_PASSWORD`, then fill in the domain, provider keys, Google OAuth credentials, and administrator emails. Keep database usernames limited to letters, numbers, underscores, and hyphens. Set `GOOGLE_REDIRECT_URI` to the exact HTTPS URL registered in Google Cloud.

Validate the Compose file without printing resolved secrets, then start it:

```bash
docker compose --env-file .env.production -f compose.prod.yml config --quiet
docker compose --env-file .env.production -f compose.prod.yml up -d --build
docker compose --env-file .env.production -f compose.prod.yml ps
```

Caddy obtains and renews the TLS certificate automatically. Once the containers are healthy, open `https://YOUR_DOMAIN` and sign in with Google.

## Updating

```bash
git pull --ff-only
docker compose --env-file .env.production -f compose.prod.yml up -d --build
docker image prune -f
```

The named MongoDB and Caddy volumes survive container replacement and `docker compose down`. Never add `--volumes` to the down command unless you intentionally want to erase the database and TLS state.

## Operations

Show service state and recent logs:

```bash
docker compose --env-file .env.production -f compose.prod.yml ps
docker compose --env-file .env.production -f compose.prod.yml logs --tail=200 app mongo proxy
```

Back up MongoDB to the current directory:

```bash
set -a
. ./.env.production
set +a
docker compose --env-file .env.production -f compose.prod.yml exec -T mongo \
  mongodump --username "$MONGO_ROOT_USERNAME" --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --db "$MONGODB_DATABASE" --archive --gzip \
  > "jev-it-$(date +%F-%H%M).archive.gz"
```

Store backups away from the VM and test restoration before relying on them. The Compose stack rotates container logs, but database backups remain an operator responsibility.

## Firewall and SSH

Allow only SSH, TCP 80/443, and UDP 443 at the VM or cloud firewall. MongoDB port 27017 and application port 3001 should remain closed because Compose does not publish them. Prefer SSH keys, disable password authentication after verifying key access, and keep the operating system and Docker patched.

## Existing reverse proxy

The included Caddy service is the recommended turnkey path. If the VM already has Nginx, Traefik, or Caddy, remove the `proxy` service, publish the app only on loopback (for example `127.0.0.1:3001:3001`), and proxy your HTTPS virtual host to that address. Do not publish MongoDB.
