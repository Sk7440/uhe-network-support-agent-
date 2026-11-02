"""Settings loaded from environment variables (.env). No hard-coded secrets."""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


class Settings:
    ollama_url: str = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
    # Needed only for Ollama's cloud API (OLLAMA_URL=https://ollama.com). Never commit it.
    ollama_api_key: str = os.getenv("OLLAMA_API_KEY", "")
    # local = run real ipconfig/ping on this machine; demo = simulated device scenarios
    diagnostics_mode: str = os.getenv("DIAGNOSTICS_MODE", "local").strip().lower()
    frontend_origin_regex: str = os.getenv("FRONTEND_ORIGIN_REGEX", "")
    chat_model: str = os.getenv("CHAT_MODEL", "gemma4:31b-cloud")
    embed_model: str = os.getenv("EMBED_MODEL", "nomic-embed-text")
    temperature: float = float(os.getenv("TEMPERATURE", "0.1"))
    max_tokens: int = int(os.getenv("MAX_TOKENS", "1024"))

    database_url: str = os.getenv("DATABASE_URL") or f"sqlite:///{(BASE_DIR / 'data' / 'uhe_agent.db').as_posix()}"
    admin_token: str = os.getenv("ADMIN_TOKEN", "")
    frontend_origins: list[str] = [
        o.strip() for o in os.getenv("FRONTEND_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()
    ]

    # Level 2 changes (ipconfig /renew, /flushdns) really run only when this is true.
    # Default false = "dry run": approved actions are logged but not executed.
    allow_level2_execution: bool = _bool("ALLOW_LEVEL2_EXECUTION", False)

    tool_timeout: int = int(os.getenv("TOOL_TIMEOUT", "15"))
    max_tool_rounds: int = int(os.getenv("MAX_TOOL_ROUNDS", "6"))
    history_limit: int = int(os.getenv("HISTORY_LIMIT", "40"))

    knowledge_dir: Path = BASE_DIR / "knowledge_base"
    prompt_file: Path = BASE_DIR / "app" / "prompts" / "system_prompt.md"
    data_dir: Path = BASE_DIR / "data"


settings = Settings()


def ollama_headers() -> dict:
    return {"Authorization": f"Bearer {settings.ollama_api_key}"} if settings.ollama_api_key else {}
settings.data_dir.mkdir(exist_ok=True)
