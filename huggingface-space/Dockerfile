FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends git iputils-ping iproute2 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user

WORKDIR /app
# Pull the backend code from the public GitHub repo
RUN git clone --depth 1 https://github.com/Sk7440/uhe-network-support-agent-.git /tmp/src \
    && cp -r /tmp/src/backend/. /app && rm -rf /tmp/src
RUN pip install --no-cache-dir -r requirements.txt
RUN mkdir -p data && chown -R user /app
USER user

ENV PORT=7860 \
    OLLAMA_URL=https://ollama.com \
    CHAT_MODEL=gemma4:31b \
    DIAGNOSTICS_MODE=demo \
    FRONTEND_ORIGIN_REGEX=https://.*vercel.app

EXPOSE 7860
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port $PORT"]
