# Production deployment

This setup runs the compiled Vue application and API together on one Node.js port. It is designed to sit behind an external reverse proxy such as Nginx Proxy Manager (NPM). MongoDB is isolated on an internal Docker network, has no published port, and uses separate root and application credentials.

## VM requirements

- A Linux VM with Docker Engine and the Docker Compose plugin.
- A domain whose A/AAAA record points to the reverse-proxy VM.
- Network access from the reverse-proxy VM to the Jev-It VM's application port.
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

For an NPM instance on another VM, keep these defaults:

```env
APP_BIND_ADDRESS=0.0.0.0
APP_PORT=3001
```

Validate the Compose file without printing resolved secrets, then start it:

```bash
docker compose --env-file .env.production -f compose.prod.yml config --quiet
docker compose --env-file .env.production -f compose.prod.yml up -d --build
docker compose --env-file .env.production -f compose.prod.yml ps
```

Once the containers are healthy, `http://JEV_IT_VM_IP:3001/api/health` should respond from the NPM VM. Do not expose that upstream port to the whole internet.

## Nginx Proxy Manager on another VM

Create the public DNS record for the application domain pointing to the **NPM VM's public IP**, not the Jev-It VM. In NPM, create a Proxy Host with:

- Domain name: the value of `DOMAIN`.
- Scheme: `http`.
- Forward hostname/IP: the Jev-It VM's reachable private or public IP.
- Forward port: the value of `APP_PORT`, normally `3001`.
- Websocket support and common-exploit blocking enabled.
- A requested SSL certificate with Force SSL enabled.

Register this exact URI in the Google OAuth Web application and use the same value in `.env.production`:

```text
https://YOUR_DOMAIN/api/auth/google/callback
```

At the cloud firewall or on the Jev-It VM, allow TCP `3001` only from the NPM VM's public or private source IP. For example with UFW, replace `NPM_VM_IP` before running:

```bash
sudo ufw allow from NPM_VM_IP to any port 3001 proto tcp
sudo ufw deny 3001/tcp
```

Confirm the upstream from the NPM VM before troubleshooting SSL:

```bash
curl -i http://JEV_IT_VM_IP:3001/api/health
```

## Updating

```bash
git pull --ff-only
docker compose --env-file .env.production -f compose.prod.yml up -d --build
docker image prune -f
```

The named MongoDB volume survives container replacement and `docker compose down`. Never add `--volumes` to the down command unless you intentionally want to erase the database.

## Operations

Show service state and recent logs:

```bash
docker compose --env-file .env.production -f compose.prod.yml ps
docker compose --env-file .env.production -f compose.prod.yml logs --tail=200 app mongo
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

## Switching an existing Jev-It Caddy deployment to remote NPM

After pulling this version and adding `APP_BIND_ADDRESS` and `APP_PORT` to `.env.production`, remove only the old Caddy container and recreate the application:

```bash
docker compose --env-file .env.production -f compose.prod.yml stop proxy
docker compose --env-file .env.production -f compose.prod.yml rm -f proxy
docker compose --env-file .env.production -f compose.prod.yml up -d --build app mongo
```

The MongoDB volume and data are unaffected.

## Optional bundled Caddy

For a standalone VM without another reverse proxy, bind the application to loopback and start the `caddy` profile:

```env
APP_BIND_ADDRESS=127.0.0.1
```

```bash
docker compose --profile caddy --env-file .env.production -f compose.prod.yml up -d --build
```

In this mode, point DNS to the Jev-It VM and allow inbound TCP 80/443 and UDP 443. Caddy obtains and renews the TLS certificate automatically.

## Firewall and SSH

Never publish MongoDB port `27017`. Prefer SSH keys, disable password authentication after verifying key access, and keep the operating system and Docker patched.
