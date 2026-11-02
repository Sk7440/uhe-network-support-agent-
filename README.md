# UHE Network Support Agent — Coded MVP

AI IT support agent for network & internet troubleshooting at the University of Home Economics, Lahore.

- **Backend:** Python FastAPI + Ollama tool calling (`gemma4:31b-cloud`) + SQLite/PostgreSQL
- **Frontend:** Next.js 16 (App Router, TypeScript, Tailwind)

## Run it

**Windows:** double-click `start.bat`. It sets everything up the first time, then opens http://localhost:3000.

| Page | URL | For |
|---|---|---|
| Assistant | http://localhost:3000 | Staff & students |
| IT Admin Console | http://localhost:3000/admin | IT administrators (sign in with `ADMIN_TOKEN` from `backend/.env`) |
| API docs | http://127.0.0.1:8001/docs | Developers |

### Manual start

```bash
# Backend
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env          # then set ADMIN_TOKEN
.venv\Scripts\python -m uvicorn app.main:app --port 8001

# Frontend (second terminal)
cd frontend
npm install
npm run dev                      # or: npm run build && npm run start
```

### Requirements

- Python 3.11+, Node.js 20+
- Ollama running and signed in (`ollama signin`) with:
  `ollama pull gemma4:31b-cloud` and `ollama pull nomic-embed-text`

## How it works

```
Browser (Next.js) ──SSE──► FastAPI /api/sessions/{id}/chat
                              │
                              ├─► Ollama gemma4:31b-cloud (tool calling, temp 0.1)
                              │      ↕ tool calls
                              ├─► Tools (validated, timed out, logged)
                              │     L1 check_ip_config · ping_gateway · check_internet · check_dns · search_knowledge_base
                              │     L2 request_change → Admin approval queue → execute / guide user
                              │     —  create_ticket → helpdesk tickets
                              │     L3 no tools exist → refused + escalated
                              └─► Database: sessions · messages · diagnostic_logs · tickets · approvals
```

### How the instructions are met

| Requirement | Implementation |
|---|---|
| Use tools strictly by their parameters | Each tool has a JSON schema. `validate_args()` rejects unknown args, wrong enums and missing fields. Inputs are checked: domains by regex, gateways must be private IPv4. Commands never run through a shell. |
| Level 1 runs automatically | Read-only tools run without asking, and every result is shown live in the chat |
| Level 2/3 need admin approval | `request_change` only creates a **pending approval**. An IT admin approves or denies it in the console. The chat waits, then continues by itself. Level 3 (firewall, router, VLAN, static IP) has no tool at all. |
| Keep conversation state | Every message, tool call and result is saved per session and restored when the page reloads |
| Log every diagnostic step | `diagnostic_logs` table: tool, level, arguments, result, status, duration, actor (agent/admin) |
| Handle timeouts and bad results | Each tool has a timeout. Failures come back as `{"status": "timeout" or "error"}`, the agent is told, and the chat never crashes. If the AI service is down, the user sees a clear message. |
| Refuse passwords and unauthorized changes | Passwords and OTPs the user types are **redacted before storing or sending to the model**. The prompt refuses credential requests and Level 3 changes. |
| No fake actions | If the model claims "request sent" or "ticket created" without calling the tool, the server discards that reply and makes it call the tool |
| Verify fixes and register tickets | The prompt says to re-check after each fix. `create_ticket` registers a structured ticket (resolved/escalated, category, priority, location, steps, cause). Admins can close or reopen it. |
| No hard-coded credentials | Everything is in `backend/.env` (see `.env.example`) |
| English + Roman Urdu | Replies in the language of the user's latest message |

## Configuration (`backend/.env`)

| Variable | Default | Notes |
|---|---|---|
| `CHAT_MODEL` | `gemma4:31b-cloud` | Any Ollama model with tool calling |
| `EMBED_MODEL` | `nomic-embed-text` | For knowledge-base search |
| `DATABASE_URL` | SQLite in `backend/data/` | PostgreSQL: `postgresql+psycopg://user:pass@host:5432/db` (+ `pip install psycopg[binary]`) |
| `ADMIN_TOKEN` | — | Required for the admin console |
| `ALLOW_LEVEL2_EXECUTION` | `false` | `false`: approved changes are logged and the user is guided to run them. `true`: approved changes run on this machine. |
| `TOOL_TIMEOUT` | `15` | Seconds per diagnostic command |

Frontend: `frontend/.env.local` → `NEXT_PUBLIC_API_URL=http://127.0.0.1:8001`

## Knowledge base

`backend/knowledge_base/*.md` — UHE subnet ranges, Wi-Fi SSID manual, gateway SOP. **Fill in the `<...>` placeholders** with real UHE values; the files are re-indexed on every backend restart. The agent is told placeholders are unknown and never presents them as facts.

## MVP limits (read before production)

1. **Diagnostics run on the machine running the backend.** For a local demo that is the user's own PC, which is correct. For a campus-wide rollout, each user's device needs a small diagnostic agent (or the users run commands themselves); the central server can't run `ipconfig` on someone else's laptop.
2. **Admin login is a single shared token.** Replace it with real accounts (e.g. Microsoft Entra ID SSO) before going live.
3. `gemma4:31b-cloud` runs on Ollama's cloud, so chat text leaves the campus. Use a local model if that is not allowed.
4. SQLite is fine for a demo. Use PostgreSQL for multiple users.
