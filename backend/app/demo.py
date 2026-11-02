"""Demo Mode: simulated device states for presentations.

When DIAGNOSTICS_MODE=demo, Level 1 tools return realistic simulated results for the
scenario chosen when the chat started, instead of checking the server's own network.
An approved Level 2 fix (renew_ip / flush_dns) can "repair" the matching scenario,
so the agent's re-check shows the problem solved.
"""

import asyncio
import random

SCENARIOS: dict[str, dict] = {
    "dhcp_failure": {
        "label": "No IP from DHCP (169.254.x.x)",
        "description": "Laptop joined Wi-Fi but never received an IP address.",
        "opening": "Wi-Fi connected hai lekin internet bilkul nahi chal raha. Sirf mera laptop, Admin Block room 12.",
        "fixed_by": "renew_ip",
    },
    "dns_failure": {
        "label": "DNS not resolving",
        "description": "Internet reachable by IP, but website names don't resolve.",
        "opening": "LAN cable lagi hai, WhatsApp chal raha hai lekin koi website nahi khul rahi. Library desk 4, only my PC.",
        "fixed_by": "flush_dns",
    },
    "gateway_down": {
        "label": "Gateway unreachable",
        "description": "Valid IP, but the local router/switch does not answer.",
        "opening": "My PC in the Computer Lab 2 has no internet since morning. The cable is plugged in.",
        "fixed_by": None,
    },
    "uplink_outage": {
        "label": "Campus internet outage",
        "description": "Local network fine, but the campus internet link is down.",
        "opening": "Nobody on the 2nd floor of the Academic Block has internet, Wi-Fi and LAN both.",
        "fixed_by": None,
    },
    "captive_portal": {
        "label": "Wi-Fi login page pending",
        "description": "Connected, but the campus Wi-Fi login (captive portal) was not completed.",
        "opening": "I joined the campus Wi-Fi on my laptop but Chrome says 'No internet'. Hostel Block B.",
        "fixed_by": None,
    },
    "healthy": {
        "label": "Healthy device",
        "description": "Everything works — shows how the agent confirms a clean bill of health.",
        "opening": "Internet thora slow lag raha hai, kya aap check kar sakte hain? Admin Block room 3, Wi-Fi.",
        "fixed_by": None,
    },
}

IP = "10.20.31.47"
GATEWAY = "10.20.31.1"
DNS_SERVERS = ["10.20.0.10", "10.20.0.11"]


def effective(scenario: str | None, fixed: list | None) -> str:
    scenario = scenario if scenario in SCENARIOS else "healthy"
    if fixed and SCENARIOS[scenario]["fixed_by"] in fixed:
        return "healthy"
    return scenario


def _ping(host: str, ok: bool, latency: float = 4.0, loss: int = 0) -> dict:
    if not ok:
        return {"host": host, "sent": 4, "received": 0, "packet_loss_pct": 100, "avg_latency_ms": None, "reachable": False}
    received = 4 - round(4 * loss / 100)
    return {"host": host, "sent": 4, "received": received, "packet_loss_pct": loss,
            "avg_latency_ms": round(latency + random.uniform(-1.5, 1.5), 1), "reachable": received > 0}


def _adapter(ipv4: str | None, gateway: str | None) -> dict:
    return {"name": "Wi-Fi", "type": "Wireless LAN", "description": "Intel(R) Wi-Fi 6 AX201 160MHz", "connected": True,
            "ipv4": ipv4, "subnet_mask": "255.255.0.0" if ipv4 and ipv4.startswith("169.254") else "255.255.255.0",
            "default_gateway": gateway, "dhcp_enabled": "Yes", "dhcp_server": None if not gateway else "10.20.0.2",
            "dns_servers": DNS_SERVERS if gateway else []}


async def simulate(tool: str, args: dict, scenario: str | None, fixed: list | None) -> dict:
    await asyncio.sleep(random.uniform(0.4, 1.4))  # realistic tool latency
    s = effective(scenario, fixed)
    sim = {"simulated": True}

    if tool == "check_ip_config":
        if s == "dhcp_failure":
            return {"status": "success", **sim, "active_adapters": [_adapter("169.254.83.112", None)],
                    "findings": ["Wi-Fi: APIPA address 169.254.83.112 — no IP received from DHCP.",
                                 "Wi-Fi: no default gateway configured."]}
        return {"status": "success", **sim, "active_adapters": [_adapter(IP, GATEWAY)], "findings": ["IP configuration looks normal."]}

    if tool == "ping_gateway":
        if s == "dhcp_failure":
            return {"status": "error", **sim, "error": "No default gateway found on any active adapter.", "reachable": False}
        if s == "gateway_down":
            return {"status": "success", **sim, **_ping(GATEWAY, False)}
        return {"status": "success", **sim, **_ping(GATEWAY, True, 3.0)}

    if tool == "check_internet":
        if s in ("dhcp_failure", "gateway_down", "uplink_outage"):
            return {"status": "success", **sim, "internet_reachable": False, "verdict": "Internet is NOT reachable.",
                    "ping": [_ping("8.8.8.8", False), _ping("1.1.1.1", False)], "http_check": {"reachable": False, "error": "ConnectTimeout"}}
        if s == "captive_portal":
            return {"status": "success", **sim, "internet_reachable": True,
                    "verdict": "Network reachable but a login (captive) portal is intercepting web traffic.",
                    "ping": [_ping("8.8.8.8", False), _ping("1.1.1.1", False)],
                    "http_check": {"reachable": True, "status_code": 302, "latency_ms": 41, "captive_portal_suspected": True}}
        return {"status": "success", **sim, "internet_reachable": True, "verdict": "Internet is reachable.",
                "ping": [_ping("8.8.8.8", True, 38), _ping("1.1.1.1", True, 35)],
                "http_check": {"reachable": True, "status_code": 200, "latency_ms": 120, "captive_portal_suspected": False}}

    if tool == "check_dns":
        domain = args.get("domain", "google.com")
        if s in ("dns_failure", "dhcp_failure", "gateway_down", "uplink_outage"):
            return {"status": "success", **sim, "domain": domain, "resolved": False,
                    "error": "[Errno 11001] getaddrinfo failed" if s != "dns_failure" else "DNS server did not respond (timeout)"}
        return {"status": "success", **sim, "domain": domain, "resolved": True, "addresses": ["142.250.181.46"],
                "lookup_ms": random.randint(12, 40)}

    raise ValueError(f"no simulation for {tool}")


SIMULATED_TOOLS = {"check_ip_config", "ping_gateway", "check_internet", "check_dns"}
