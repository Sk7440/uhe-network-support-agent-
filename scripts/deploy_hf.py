"""Create/update the Hugging Face Space for the backend, set secrets, upload code.

Reads OLLAMA_API_KEY, ADMIN_TOKEN, CHAT_MODEL from the environment (set by deploy.ps1).
Prints the Space URL as the last line:  SPACE_URL=https://...
"""

import os
import sys
from pathlib import Path

from huggingface_hub import HfApi

SPACE_NAME = "uhe-network-agent-api"
BACKEND = Path(__file__).resolve().parent.parent / "backend"

api = HfApi()
user = api.whoami()["name"]
repo_id = f"{user}/{SPACE_NAME}"
print(f"[hf] account: {user}")

api.create_repo(repo_id, repo_type="space", space_sdk="docker", exist_ok=True, private=False)
print(f"[hf] space ready: https://huggingface.co/spaces/{repo_id}")

for key in ("OLLAMA_API_KEY", "ADMIN_TOKEN"):
    value = os.environ.get(key)
    if not value:
        sys.exit(f"[hf] missing {key}")
    api.add_space_secret(repo_id, key, value)
model = os.environ.get("CHAT_MODEL")
if model:
    api.add_space_variable(repo_id, "CHAT_MODEL", model)
print("[hf] secrets set: OLLAMA_API_KEY, ADMIN_TOKEN" + (f" | CHAT_MODEL={model}" if model else ""))

api.upload_folder(
    repo_id=repo_id,
    repo_type="space",
    folder_path=str(BACKEND),
    commit_message="Deploy UHE Network Support Agent backend",
    ignore_patterns=[".venv/*", ".venv/**", ".env", "data/*", "data/**", "**/__pycache__/**", "*.pyc"],
)
print("[hf] code uploaded; Space is building")

host = None
try:
    host = getattr(api.space_info(repo_id), "host", None)
except Exception:
    pass
if not host:
    host = f"https://{user.lower().replace('_', '-').replace('.', '-')}-{SPACE_NAME}.hf.space"
print(f"SPACE_URL={host.rstrip('/')}")
