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

## 1. Backend → Hugging Face Space

1. huggingface.co → Settings → **Access Tokens** → New token, type **Write**.
2. Log in from this PC (paste the token when asked — in your terminal, not in chat):
   ```
   backend\.venv\Scripts\hf auth login
   ```
3. Create the Space and upload the backend:
   ```
   cd backend
   .venv\Scripts\hf repo create uhe-network-agent-api --repo-type space --space-sdk docker
   .venv\Scripts\hf upload <your-hf-username>/uhe-network-agent-api . . --repo-type space --exclude ".venv/*" ".env" "data/*" "__pycache__/*" "*/__pycache__/*"
   ```
4. On the Space page → **Settings → Variables and secrets → New secret**:
   - `OLLAMA_API_KEY` = your Ollama key
   - `ADMIN_TOKEN` = a long random password for the admin console
   Then **Restart Space**.
5. Backend URL: `https://<your-hf-username>-uhe-network-agent-api.hf.space`
   Check `<URL>/api/health` → `"ollama": true`.

> The Space must be **public** so the website can call it. Only code is public — keys stay in Secrets.

## 2. Frontend → Vercel

```
cd frontend
vercel link
vercel env add NEXT_PUBLIC_API_URL production     # paste the HF Space URL (no trailing slash)
vercel --prod
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
