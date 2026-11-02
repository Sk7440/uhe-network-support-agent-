---
title: UHE Network Support Agent API
emoji: 🛜
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 8001
pinned: false
short_description: FastAPI backend for the UHE network support AI agent
---

# UHE Network Support Agent — API

FastAPI backend (Ollama tool-calling agent). Health check: `/api/health` · API docs: `/docs`.

Required **Secrets** (Space → Settings → Variables and secrets):

- `OLLAMA_API_KEY` — from ollama.com/settings/keys
- `ADMIN_TOKEN` — any long random string (used to sign in to the admin console)
