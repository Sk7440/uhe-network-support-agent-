# Deploy the demo (free): Render (backend) + Vercel (frontend)

Result: a public https link for the assistant + admin console, running in **Demo Mode**
(simulated device faults so every presentation shows a full diagnose → approve → fix → ticket flow).

```
Vercel (Next.js)  ──https──►  Render (FastAPI, Docker)  ──►  Ollama Cloud API (gemma4:31b)
```

## 0. Accounts you need (all free)

| Service | Why |
|---|---|
| GitHub | Holds the code (private repo) |
| Render — render.com | Runs the backend |
| Vercel — vercel.com | Runs the frontend |
| Ollama — ollama.com/settings/keys | **API key** so the server can use gemma4 cloud |

## 1. Push the code to GitHub (private)

```bash
cd "Coded Agent"
gh repo create uhe-network-support-agent --private --source=. --remote=origin --push
```

## 2. Backend on Render

1. render.com → **New → Blueprint** → connect GitHub → pick `uhe-network-support-agent`.
2. Render reads `render.yaml` and asks for **OLLAMA_API_KEY** → paste your key from ollama.com/settings/keys.
3. Click **Apply**. Wait for the build (~3–5 min).
4. Copy the service URL, e.g. `https://uhe-network-agent-api.onrender.com`.
   Check: open `<URL>/api/health` → should show `"ollama": true`.
5. Service → **Environment** → copy the generated **ADMIN_TOKEN** (used to sign in to the admin console).

## 3. Frontend on Vercel

```bash
cd frontend
vercel link                     # create project "uhe-network-support-agent"
vercel env add NEXT_PUBLIC_API_URL production   # paste the Render URL (no trailing slash)
vercel --prod
```

(Or in the Vercel dashboard: **Add New → Project** → import the repo → **Root Directory = `frontend`** → add env var `NEXT_PUBLIC_API_URL` = Render URL → Deploy.)

## 4. Test

- Open the Vercel URL → pick **"No IP from DHCP"** → agent diagnoses and requests approval.
- Open `<Vercel URL>/admin` in another tab → sign in with ADMIN_TOKEN → **Approve**.
- Back in the chat: agent re-checks, confirms fix, registers ticket.

## Before the presentation

- **Render free tier sleeps after 15 min idle.** Open `<Render URL>/api/health` ~1 minute before presenting to wake it.
- The free tier's disk is temporary: tickets/logs reset when the service restarts. Fine for demos; for persistence add a Render PostgreSQL database and set `DATABASE_URL` (+ add `psycopg[binary]` to requirements.txt).
- To run real diagnostics instead of simulated ones, run the project locally (`start.bat`) — a cloud server can only test its own network.
