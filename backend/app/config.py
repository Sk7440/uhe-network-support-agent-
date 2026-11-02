"""Settings loaded from environment variables (.env). No hard-coded secrets."""

import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

# On Vercel the code folder is read-only and there is no local Ollama,
# so cloud-friendly defaults apply unless overridden by environment variables.
ON_VERCEL = bool(os.getenv("VERCEL"))
CLOUD = ON_VERCEL


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _database_url(data_dir: Path) -> str:
    """DATABASE_URL / POSTGRES_URL (e.g. Neon) or a local SQLite file."""
    url = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL") or ""
    if not url:
        return f"sqlite:///{(data_dir / 'uhe_agent.db').as_posix()}"
    # Neon/Vercel give postgres:// or postgresql:// — SQLAlchemy needs the psycopg (v3) driver name
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


class Settings:
    ollama_url: str = os.getenv("OLLAMA_URL", "https://ollama.com" if CLOUD else "http://localhost:11434").rstrip("/")
    # Needed only for Ollama's cloud API (OLLAMA_URL=https://ollama.com). Never commit it.
    ollama_api_key: str = os.getenv("OLLAMA_API_KEY", "")
    # local = run real ipconfig/ping on this machine; demo = simulated device scenarios
    diagnostics_mode: str = os.getenv("DIAGNOSTICS_MODE", "demo" if CLOUD else "local").strip().lower()
    frontend_origin_regex: str = os.getenv("FRONTEND_ORIGIN_REGEX", r"https://.*\.vercel\.app" if CLOUD else "")
    chat_model: str = os.getenv("CHAT_MODEL", "gemma4:31b" if CLOUD else "gemma4:31b-cloud")
    embed_model: str = os.getenv("EMBED_MODEL", "nomic-embed-text")
    temperature: float = float(os.getenv("TEMPERATURE", "0.1"))
    max_tokens: int = int(os.getenv("MAX_TOKENS", "1024"))

    data_dir: Path = Path(tempfile.gettempdir()) / "uhe_agent" if ON_VERCEL else BASE_DIR / "data"
    database_url: str = _database_url(data_dir)
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


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)


def ollama_headers() -> dict:
    return {"Authorization": f"Bearer {settings.ollama_api_key}"} if settings.ollama_api_key else {}
