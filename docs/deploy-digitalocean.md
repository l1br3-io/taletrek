# Deploying TaleTrek to a DigitalOcean Droplet

> The self-hosted shape (ADR-0013/0014): **your** server, **your** library —
> Docker on a box you control, the Jellyfin model. There is no TaleTrek-operated
> cloud; the token is the entire auth surface, so the deployment below puts TLS
> in front of it before anything touches the internet.

Two supported paths: **build on the Droplet** (simplest, needs a ≥4 GB Droplet
for the Rust compile) or **build locally, ship the image** (works on the
cheapest 1 GB Droplet). Both end at the same `docker run`.

## 0. Create the Droplet

- Image: **Ubuntu 24.04 LTS**, plan: **Basic / 1 vCPU / 1 GB** ($6/mo) if you
  ship a prebuilt image, or **2 vCPU / 4 GB** for on-Droplet builds.
- Add your SSH key; enable backups (the volume below is the whole library).
- Note the public IP, then lock the box down:

```
ssh root@<droplet-ip>
ufw allow OpenSSH && ufw enable
```

## 1. Install Docker + Caddy

```
curl -fsSL https://get.docker.com | sh        # official convenience script
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

Caddy gives the TLS terminator: TaleTrek speaks plain HTTP on loopback, Caddy
owns the certificate. **HTTPS is not optional** for internet-facing use —
plain HTTP leaks the bearer token + your books in cleartext, and the hosted
PWA (service worker, install prompt) requires a secure context on
non-localhost origins.

Point a DNS **A record** at the Droplet IP first (Caddy issues the
certificate on first request), then:

```
cat >/etc/caddy/Caddyfile <<'EOF'
taletrek.example.com {
    reverse_proxy 127.0.0.1:7878
}
EOF
systemctl reload caddy
```

## 2a. Build on the Droplet

```
apt-get install -y git
git clone https://github.com/l1br3-io/taletrek.git   # or your fork
cd taletrek
docker build -f server/Dockerfile -t taletrek-server .
```

The build is self-contained (Rust toolchain, pnpm, Piper tarball — all fetched
in-image; the SPA builds automatically since effort 5).

## 2b. …or ship a prebuilt image

On your machine:

```
docker build -f server/Dockerfile -t taletrek-server .
docker save taletrek-server | gzip > tt.tar.gz
scp tt.tar.gz root@<droplet-ip>:
```

On the Droplet:

```
docker load < tt.tar.gz
```

## 3. Run it

Generate the token **first** and save it — the server never logs or echoes it
again:

```
TALETREK_TOKEN="$(openssl rand -hex 32)"
echo "token: $TALETREK_TOKEN"    # ← copy into your password manager now
docker run -d --name taletrek \
  --restart unless-stopped \
  -p 127.0.0.1:7878:7878 \
  -e TALETREK_TOKEN="$TALETREK_TOKEN" \
  -v tt-data:/data \
  taletrek-server
docker logs taletrek 2>&1 | head    # note the listening line; token is NOT logged
```

- The port is published to **loopback only** — Caddy is the only client.
- `-v tt-data:/data` holds the library, the SQLite index, and the voice-model
  cache (~63 MB per voice, downloaded on first synth) across upgrades.
- Save the token somewhere safe (password manager): it is the only
  credential, and a lost token means re-issuing the container with a new one.

Open `https://taletrek.example.com` → the login page → the hosted SPA. Upload
a book, close the tab, come back tomorrow — synthesis finished without you.

## 4. Operating

- **Update:** `git pull && docker build -f server/Dockerfile -t taletrek-server . &&
  docker rm -f taletrek &&` re-run the `docker run` above **with your saved
  token** — a fresh `openssl rand` would mint a different credential and lock
  you out (the volume keeps everything). For shipped images: build, `save`,
  `load`, swap.
- **Backup:** everything lives in the `tt-data` volume —
  `docker run --rm -v tt-data:/data -v $(pwd):/backup alpine tar czf /backup/tt-data.tgz /data`.
- **Watch a synth job:** `docker logs -f taletrek`, or the job chip in the
  library UI.
- **Trusting it:** the server is single-user by design. Anyone with the token
  (or the cookie it mints) has full read/write. Don't share the origin; put it
  behind TLS (done above); use a 32-byte random token.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Login loops back to the login page | Cookie blocked — check the browser isn't isolating the site, and that you're on the exact Caddy hostname (the cookie is host-only). |
| `docker logs` shows a piper/ffmpeg error at synth | The image ships both; if you overrode `TALETREK_PIPER`/`TALETREK_FFMPEG`, point them at real binaries. |
| PWA won't install | Requires HTTPS via a real origin (Caddy) — service workers don't register on plain-HTTP non-localhost, and the manifest sits behind the login cookie (sign in first). |
| First synth is slow | It's downloading the voice model (~63 MB) into `/data/voices` — once per voice, cached on the volume. |

See also: [`docs/specs/personal-server/runbook.md`](specs/personal-server/runbook.md)
(the API-level smoke loop) and
[`docs/specs/server-hosted-spa/runbook.md`](specs/server-hosted-spa/runbook.md)
(the hosted walkthrough this deployment serves).
