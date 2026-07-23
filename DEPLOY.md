# Deploying the Transaction Firewall

This app is **not** a static site. On startup it launches a real **Anvil** node
(forking Sepolia), compiles/deploys demo contracts, and — for the proof
features — forks live networks in child processes. So it needs a **container
host that can run a long-lived process with a few hundred MB of RAM and
outbound internet.** Serverless hosts (Vercel, Netlify, GitHub Pages) cannot run
it.

The repo ships a `Dockerfile` that installs Foundry (`anvil`) + Node and runs the
server. Any Docker-capable host works. Two easy paths:

## Option A — Render (recommended, one-connect)

1. Push this repo to GitHub (already done).
2. Go to <https://dashboard.render.com> → **New → Blueprint**.
3. Connect this repository. Render reads `render.yaml` + `Dockerfile`
   automatically and creates the web service.
4. Pick a plan when prompted:
   - **Starter (512 MB, ~$7/mo)** — runs the core demo (two-run, agent
     playground) fine.
   - **Standard (2 GB)** — recommended if you want the **Real-World Proof** and
     **Historical Replay** (mainnet archive forks) to be rock-solid for judges.
5. Deploy. First build takes ~3–5 min (it installs Foundry). When it's live,
   open the Render URL — watch the logs for `Chain up: SEPOLIA FORK`.

The server binds the port immediately and boots the chain in the background, so
the health check (`/api/chain`) passes right away.

## Option B — Railway

1. <https://railway.app> → **New Project → Deploy from GitHub repo** → pick this
   repo. Railway auto-detects the `Dockerfile`.
2. Under the service's **Settings → Networking**, click **Generate Domain**.
3. It builds and deploys. Railway's usage-based pricing includes a small free
   credit; give the service ~1–2 GB if you'll use the replay features.

## Notes for a public/judge-facing deploy

- **No secrets required.** RPC endpoints default to public nodes. The co-signer
  key is generated fresh on first boot (testnet-only) and never leaves the box.
- **Pre-warm the heavy buttons.** The Real-World Proof and Historical Replay fork
  an archive node and take ~30–60s the first time (cached after). Click them once
  after deploy so they're warm before anyone else does.
- **If the replay features are flaky** on a small instance, the core demo still
  works — they fail closed with an on-screen error, they don't crash the app.
- **Env overrides** (optional): `PORT`, `SEPOLIA_RPC_URL`, `MAINNET_RPC_URL`.

## Run locally instead

```bash
npm install
npm run dev     # → http://localhost:4780
```

Or via Docker locally:

```bash
docker build -t transaction-firewall .
docker run -p 4780:4780 transaction-firewall
```
