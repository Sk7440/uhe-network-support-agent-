# Deploy the demo — 100% free, no credit card

```
Vercel (Next.js frontend)  ──https──►  Hugging Face Space (FastAPI, Docker)  ──►  Ollama Cloud API (gemma4:31b)
```

Runs in **Demo Mode**: simulated device faults, so every presentation shows the full
diagnose → admin approval → fix → verify → ticket flow.

## 0. Free accounts

| Service | Why |
|---|---|
| Hugging Face — huggingface.co/join | Runs the backend (free CPU Space, sleeps after 48 h idle) |
| Vercel — vercel.com | Runs the frontend |
| Ollama — ollama.com/settings/keys | API key so the server can use gemma4 cloud |

## 1. One-click deploy

Double-click **`deploy.bat`** (in this folder). It will:

1. Log you in to Hugging Face (paste a **Write** token from huggingface.co/settings/tokens) and Vercel if needed.
2. Ask for your **Ollama API key** (typed in the terminal, hidden) and test that `gemma4` works with it.
3. Create a random **admin token** → saved to `admin-token.txt` (not committed).
4. Push the code to a **private** GitHub repo.
5. Create the Hugging Face Space, set the secrets, upload the backend, wait until it is online.
6. Deploy the frontend to Vercel with the backend URL and open the site.

Re-run `deploy.bat` any time to update the deployment.

> The Space is **public** (so the website can call it). Only code is public — keys stay in Space Secrets.

## 2. Manual alternative

```
backend\.venv\Scripts\hf auth login
set OLLAMA_API_KEY=...   &  set ADMIN_TOKEN=...   &  set CHAT_MODEL=gemma4:31b
backend\.venv\Scripts\python scripts\deploy_hf.py           # prints SPACE_URL=...
cd frontend
vercel link --yes --project uhe-network-support-agent
vercel env add NEXT_PUBLIC_API_URL --environment production --value <SPACE_URL> --force --yes
vercel --prod --yes
```

## 3. Test the demo

1. Open the Vercel URL → pick **"No IP from DHCP"**.
2. Open `<Vercel URL>/admin` in another tab → sign in with ADMIN_TOKEN → **Approve**.
3. Back in the chat: the agent re-checks, confirms the fix, registers a ticket.

## Notes

- Open `<HF URL>/api/health` a minute before presenting if the Space was idle for 2+ days (cold start).
- Tickets/logs live in SQLite inside the Space and reset when it restarts — fine for demos.
  For permanent storage, create a free Neon Postgres DB and set `DATABASE_URL` (+ `psycopg[binary]` in requirements.txt).
- Real diagnostics of the user's own PC: run locally with `start.bat` (a cloud server can only test its own network).
