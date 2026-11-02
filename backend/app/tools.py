"""Approved diagnostic tools exposed to the agent.

Every tool:
  - has a permission level (1 = read-only, 2 = needs admin approval; level 3 has no tools),
  - validates its input strictly,
  - runs with a timeout and returns {"status": "success" | "error" | "timeout" | ..., ...}.
"""

import asyncio
import ipaddress
import json
import math
import platform
import re
import socket
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from .config import ollama_headers, settings

IS_WINDOWS = platform.system() == "Windows"
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$", re.I)


class ToolError(Exception):
    pass


# ---------------------------------------------------------------- helpers
def _run(cmd: list[str], timeout: int) -> str:
    """Run a fixed command (never via shell). Raises ToolError / TimeoutError."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as e:
        raise TimeoutError(f"'{cmd[0]}' did not finish in {timeout}s") from e
    except FileNotFoundError as e:
        raise ToolError(f"'{cmd[0]}' is not available on this system") from e
    return (proc.stdout or "") + (proc.stderr or "")


def _is_apipa(ip: str) -> bool:
    return ip.startswith("169.254.")


def _parse_windows_ipconfig(text: str) -> list[dict]:
    adapters, cur, last_key = [], None, None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        if not raw.startswith(" ") and raw.rstrip().endswith(":"):
            name = raw.rstrip()[:-1]
            if "adapter" in name.lower():
                cur = {"name": name.split("adapter", 1)[1].strip(), "type": name.split("adapter", 1)[0].strip(), "fields": {}}
                adapters.append(cur)
            else:
                cur = None
            last_key = None
            continue
        if cur is None:
            continue
        m = re.match(r"^\s+([A-Za-z0-9 \-]+?)[ .]*:\s?(.*)$", raw)
        if m and ". ." in raw or (m and raw.strip().endswith(":")):
            last_key = m.group(1).strip()
            cur["fields"].setdefault(last_key, [])
            if m.group(2).strip():
                cur["fields"][last_key].append(m.group(2).strip())
        elif last_key:  # continuation line (multi-value fields)
            cur["fields"][last_key].append(raw.strip())

    out = []
    for a in adapters:
        f = a["fields"]
        get = lambda k: f.get(k, [])
        clean = lambda v: re.sub(r"\(.*?\)", "", v).strip()
        ipv4 = [clean(v) for v in get("IPv4 Address") + get("Autoconfiguration IPv4 Address")]
        gateways = [v for v in get("Default Gateway") if re.fullmatch(r"\d+\.\d+\.\d+\.\d+", v)]
        dns = [v for v in get("DNS Servers") if re.fullmatch(r"\d+\.\d+\.\d+\.\d+", v)]
        media = (get("Media State") or ["Connected"])[0]
        out.append({
            "name": a["name"],
            "type": a["type"],
            "description": (get("Description") or [""])[0],
            "connected": "disconnected" not in media.lower(),
            "ipv4": ipv4[0] if ipv4 else None,
            "subnet_mask": (get("Subnet Mask") or [None])[0],
            "default_gateway": gateways[0] if gateways else None,
            "dhcp_enabled": (get("DHCP Enabled") or ["?"])[0],
            "dhcp_server": (get("DHCP Server") or [None])[0],
            "dns_servers": dns,
        })
    return out


def _parse_linux() -> list[dict]:
    addr = json.loads(_run(["ip", "-j", "-4", "addr"], settings.tool_timeout) or "[]")
    route = json.loads(_run(["ip", "-j", "-4", "route"], settings.tool_timeout) or "[]")
    gw = {r.get("dev"): r.get("gateway") for r in route if r.get("dst") == "default"}
    out = []
    for a in addr:
        if a.get("ifname") == "lo":
            continue
        info = (a.get("addr_info") or [{}])[0]
        out.append({
            "name": a.get("ifname"), "type": "", "description": "",
            "connected": a.get("operstate") == "UP",
            "ipv4": info.get("local"), "subnet_mask": f"/{info.get('prefixlen')}" if info else None,
            "default_gateway": gw.get(a.get("ifname")), "dhcp_enabled": "?", "dhcp_server": None, "dns_servers": [],
        })
    return out


def _ping(host: str, count: int = 4) -> dict:
    cmd = ["ping", "-n", str(count), "-w", "2000", host] if IS_WINDOWS else ["ping", "-c", str(count), "-W", "2", host]
    text = _run(cmd, timeout=count * 3 + 5)
    received = len(re.findall(r"ttl=", text, re.I))
    times = [float(t) for t in re.findall(r"time[=<]\s*([\d.]+)\s*ms", text, re.I)]
    return {
        "host": host,
        "sent": count,
        "received": received,
        "packet_loss_pct": round(100 * (count - received) / count),
        "avg_latency_ms": round(sum(times) / len(times), 1) if times else None,
        "reachable": received > 0,
    }


# ---------------------------------------------------------------- Level 1 tools
async def check_ip_config() -> dict:
    def work():
        if IS_WINDOWS:
            return _parse_windows_ipconfig(_run(["ipconfig", "/all"], settings.tool_timeout))
        return _parse_linux()

    adapters = await asyncio.to_thread(work)
    active = [a for a in adapters if a["connected"] and a["ipv4"]]
    findings = []
    if not active:
        findings.append("No connected adapter has an IPv4 address (cable unplugged / Wi-Fi not connected).")
    for a in active:
        if _is_apipa(a["ipv4"]):
            findings.append(f"{a['name']}: APIPA address {a['ipv4']} — no IP received from DHCP.")
        if not a["default_gateway"]:
            findings.append(f"{a['name']}: no default gateway configured.")
    # Hide virtual/disconnected adapters to keep the output focused
    shown = active or [a for a in adapters if a["connected"]]
    return {"status": "success", "active_adapters": shown, "findings": findings or ["IP configuration looks normal."]}


async def ping_gateway(gateway: str | None = None) -> dict:
    if gateway:
        try:
            ip = ipaddress.ip_address(gateway)
        except ValueError:
            raise ToolError("gateway must be a valid IP address")
        if ip.version != 4 or not ip.is_private:
            raise ToolError("only private (local network) IPv4 gateways can be pinged")
        target = str(ip)
    else:
        cfg = await check_ip_config()
        gws = [a["default_gateway"] for a in cfg["active_adapters"] if a.get("default_gateway")]
        if not gws:
            return {"status": "error", "error": "No default gateway found on any active adapter.", "reachable": False}
        target = gws[0]
    res = await asyncio.to_thread(_ping, target)
    return {"status": "success", **res}


async def check_internet() -> dict:
    pings = await asyncio.gather(*(asyncio.to_thread(_ping, h, 3) for h in ("8.8.8.8", "1.1.1.1")), return_exceptions=True)
    ping_results = [p if isinstance(p, dict) else {"error": str(p), "reachable": False} for p in pings]

    http = {"reachable": False}
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=False) as c:
            t0 = time.perf_counter()
            r = await c.get("http://www.msftconnecttest.com/connecttest.txt")
            http = {
                "reachable": True,
                "status_code": r.status_code,
                "latency_ms": round((time.perf_counter() - t0) * 1000),
                "captive_portal_suspected": not (r.status_code == 200 and "Microsoft Connect Test" in r.text),
            }
    except httpx.HTTPError as e:
        http = {"reachable": False, "error": type(e).__name__}

    online = any(p.get("reachable") for p in ping_results) or http.get("reachable")
    if http.get("captive_portal_suspected"):
        verdict = "Network reachable but a login (captive) portal is intercepting web traffic."
    elif online:
        verdict = "Internet is reachable."
    else:
        verdict = "Internet is NOT reachable."
    return {"status": "success", "internet_reachable": bool(online), "verdict": verdict, "ping": ping_results, "http_check": http}


async def check_dns(domain: str = "google.com") -> dict:
    domain = domain.strip().lower().rstrip(".")
    if not DOMAIN_RE.match(domain):
        raise ToolError("domain must be a valid hostname like google.com")
    t0 = time.perf_counter()
    try:
        infos = await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo, domain, 443, socket.AF_INET), timeout=6)
    except socket.gaierror as e:
        return {"status": "success", "domain": domain, "resolved": False, "error": str(e)}
    addrs = sorted({i[4][0] for i in infos})
    return {"status": "success", "domain": domain, "resolved": True, "addresses": addrs[:5],
            "lookup_ms": round((time.perf_counter() - t0) * 1000)}


# ---------------------------------------------------------------- knowledge base
class KnowledgeBase:
    """Vector search via Ollama embeddings; falls back to keyword search if embeddings are unavailable
    (e.g. Ollama cloud API without the embedding model)."""

    def __init__(self):
        self.chunks: list[dict] = []
        self.mode = "none"

    @staticmethod
    def _words(text: str) -> list[str]:
        return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2]

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=60, headers=ollama_headers()) as c:
            r = await c.post(f"{settings.ollama_url}/api/embed", json={"model": settings.embed_model, "input": texts})
            r.raise_for_status()
            return r.json()["embeddings"]

    async def build(self) -> int:
        chunks = []
        for f in sorted(settings.knowledge_dir.glob("*.md")):
            text = f.read_text(encoding="utf-8")
            title = (re.search(r"^# (.+)$", text, re.M) or [None, f.stem])[1]
            for part in re.split(r"(?m)^(?=## )", text):
                if len(part.strip()) > 40:
                    chunks.append({"source": f.name, "text": f"[{title}]\n{part.strip()}"})
        self.mode = "keyword"
        if chunks:
            try:
                for c, v in zip(chunks, await self._embed([c["text"] for c in chunks])):
                    c["vec"] = v
                self.mode = "vector"
            except Exception:
                pass  # keyword search still works
        self.chunks = chunks
        return len(chunks)

    async def search(self, query: str, k: int = 3) -> list[dict]:
        if not self.chunks:
            return []
        if self.mode != "vector":
            terms = set(self._words(query))
            scored = []
            for c in self.chunks:
                words = self._words(c["text"])
                hits = sum(1 for w in words if w in terms)
                if hits:
                    scored.append((hits / math.sqrt(len(words)), c))
            scored.sort(key=lambda s: s[0], reverse=True)
            return [{"source": c["source"], "score": round(s, 3), "text": c["text"]} for s, c in scored[:k]]
        q = (await self._embed([query]))[0]
        norm = lambda v: math.sqrt(sum(x * x for x in v)) or 1.0
        qn = norm(q)
        scored = [(sum(a * b for a, b in zip(q, c["vec"])) / (qn * norm(c["vec"])), c) for c in self.chunks]
        scored.sort(key=lambda s: s[0], reverse=True)
        return [{"source": c["source"], "score": round(s, 3), "text": c["text"]} for s, c in scored[:k] if s > 0.35]


KB = KnowledgeBase()


async def search_knowledge_base(query: str) -> dict:
    query = query.strip()[:300]
    if not query:
        raise ToolError("query is required")
    hits = await KB.search(query)
    return {
        "status": "success",
        "results": hits,
        "note": "Values in <angle brackets> are unfilled placeholders — treat them as UNKNOWN, never as real values.",
    }


# ---------------------------------------------------------------- Level 2 (executed only after admin approval)
LEVEL2_ACTIONS: dict[str, dict] = {
    "renew_ip": {
        "label": "Release and renew IP address (DHCP)",
        "commands": [["ipconfig", "/release"], ["ipconfig", "/renew"]] if IS_WINDOWS else [["dhclient", "-r"], ["dhclient"]],
        "impact": "Network disconnects for a few seconds.",
    },
    "flush_dns": {
        "label": "Flush DNS resolver cache",
        "commands": [["ipconfig", "/flushdns"]] if IS_WINDOWS else [["resolvectl", "flush-caches"]],
        "impact": "No disconnection; DNS cache is cleared.",
    },
}


def execute_level2(action: str) -> dict:
    """Called ONLY from the admin approval endpoint."""
    spec = LEVEL2_ACTIONS[action]
    if not settings.allow_level2_execution:
        return {"status": "dry_run", "message": "Approved. Execution is disabled on this server (ALLOW_LEVEL2_EXECUTION=false), "
                "so the user should perform the step manually.", "commands": [" ".join(c) for c in spec["commands"]]}
    outputs = []
    for cmd in spec["commands"]:
        try:
            outputs.append({"command": " ".join(cmd), "output": _run(cmd, timeout=60)[-800:]})
        except (ToolError, TimeoutError) as e:
            return {"status": "failed", "error": str(e), "outputs": outputs}
    return {"status": "executed", "outputs": outputs}


# ---------------------------------------------------------------- registry
@dataclass
class Tool:
    name: str
    level: int
    description: str
    parameters: dict
    fn: Callable[..., Awaitable[dict]] | None  # None = handled by the agent (needs DB)

    def schema(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


NO_PARAMS = {"type": "object", "properties": {}, "required": []}

TOOLS: dict[str, Tool] = {t.name: t for t in [
    Tool("check_ip_config", 1, "Level 1 read-only. Returns the user's active network adapters: IPv4, subnet, default gateway, DHCP, DNS servers, and findings such as APIPA (169.254.x.x).", NO_PARAMS, check_ip_config),
    Tool("ping_gateway", 1, "Level 1 read-only. Pings the local default gateway (auto-detected if not given) and reports packet loss and latency.",
         {"type": "object", "properties": {"gateway": {"type": "string", "description": "Optional private IPv4 gateway address. Omit to auto-detect."}}, "required": []}, ping_gateway),
    Tool("check_internet", 1, "Level 1 read-only. Tests public internet reachability (ping 8.8.8.8 and 1.1.1.1) and an HTTP check that detects captive login portals.", NO_PARAMS, check_internet),
    Tool("check_dns", 1, "Level 1 read-only. Resolves a domain name to check DNS is working.",
         {"type": "object", "properties": {"domain": {"type": "string", "description": "Domain to resolve, e.g. google.com"}}, "required": []}, check_dns),
    Tool("search_knowledge_base", 1, "Level 1 read-only. Searches UHE documentation: IP subnet ranges per building, Wi-Fi SSIDs, gateway SOP, escalation contacts.",
         {"type": "object", "properties": {"query": {"type": "string", "description": "What to look up"}}, "required": ["query"]}, search_knowledge_base),
    Tool("request_change", 2, "Level 2. Requests a controlled change (renew_ip or flush_dns). Does NOT execute it: creates a request that a human IT administrator must approve. Use only when diagnostics show it is needed.",
         {"type": "object", "properties": {
             "action": {"type": "string", "enum": list(LEVEL2_ACTIONS), "description": "renew_ip (fixes DHCP/APIPA) or flush_dns (fixes stale DNS)"},
             "reason": {"type": "string", "description": "Evidence from diagnostics that justifies the change"}},
          "required": ["action", "reason"]}, None),
    Tool("create_ticket", 1, "Registers a structured helpdesk ticket. Use status 'resolved' when fixed, 'escalated' when a human technician is needed (area-wide outage, Level 3 request, unresolved).",
         {"type": "object", "properties": {
             "status": {"type": "string", "enum": ["resolved", "escalated"]},
             "category": {"type": "string", "enum": ["wifi", "lan", "dhcp_ip", "gateway", "dns", "internet_uplink", "slow_network", "security_request", "other"]},
             "priority": {"type": "string", "enum": ["low", "medium", "high"]},
             "summary": {"type": "string", "description": "One-paragraph problem summary and outcome"},
             "location": {"type": "string", "description": "Building / floor / room, if known"},
             "connection_type": {"type": "string", "enum": ["wifi", "lan", "both", "unknown"]},
             "steps_tried": {"type": "string", "description": "Diagnostics and actions performed, with results"},
             "suspected_cause": {"type": "string"}},
          "required": ["status", "category", "priority", "summary"]}, None),
]}


def validate_args(tool: Tool, args: Any) -> dict:
    """Strict validation against the tool's JSON schema (types, enums, required, no extras)."""
    if args is None or args == "":
        args = {}
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            raise ToolError("arguments must be a JSON object")
    if not isinstance(args, dict):
        raise ToolError("arguments must be an object")
    props = tool.parameters.get("properties", {})
    extra = set(args) - set(props)
    if extra:
        raise ToolError(f"unknown argument(s): {', '.join(sorted(extra))}")
    for req in tool.parameters.get("required", []):
        if req not in args or args[req] in (None, ""):
            raise ToolError(f"missing required argument: {req}")
    clean = {}
    for k, v in args.items():
        if v is None:
            continue
        if not isinstance(v, str):
            v = str(v)
        v = v.strip()[:2000]
        enum = props[k].get("enum")
        if enum and v not in enum:
            raise ToolError(f"{k} must be one of: {', '.join(enum)}")
        clean[k] = v
    return clean
