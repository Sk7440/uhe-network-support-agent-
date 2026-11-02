FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# ping + ip are used by the real (local) diagnostics mode
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping iproute2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY knowledge_base ./knowledge_base
RUN mkdir -p data && useradd -m -u 1000 agent && chown -R agent /app
USER agent

# Cloud demo defaults (override in your host's settings). Secrets are NOT set here:
# OLLAMA_API_KEY and ADMIN_TOKEN must be added as secrets on the host.
ENV PORT=8001 \
    OLLAMA_URL=https://ollama.com \
    CHAT_MODEL=gemma4:31b \
    DIAGNOSTICS_MODE=demo \
    FRONTEND_ORIGIN_REGEX=https://.*\.vercel\.app
EXPOSE 8001
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers"]
