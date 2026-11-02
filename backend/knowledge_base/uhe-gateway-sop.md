# UHE Lahore — Gateway & Connectivity SOP

> TEMPLATE: replace `<...>` with real values from UHE IT.

## Standard diagnostic order

1. Scope: Wi-Fi or LAN, single device or many, location.
2. Physical: Wi-Fi on / correct SSID, or cable + port lights.
3. `ipconfig` → check IPv4, subnet mask, default gateway.
4. `ping <gateway>` → `ping 8.8.8.8` → `ping google.com`.
5. Apply Level 2 fix only with user consent.
6. Verify, then summarise or escalate.

## Reading ping results

| Result | Meaning | Next step |
|---|---|---|
| Gateway: Request timed out | Device can't reach the local network | Check Wi-Fi/cable; Level 2 reconnect; escalate if many users |
| Gateway OK, 8.8.8.8 fails | Campus internet uplink problem | Escalate (High priority if area-wide) |
| 8.8.8.8 OK, google.com fails | DNS problem | Level 2: `ipconfig /flushdns`; escalate if persists |
| All OK but slow | Congestion / weak signal | Check signal, time of day, others affected |

## Permission levels

| Level | Actions | Rule |
|---|---|---|
| 1 — Read-only | `ipconfig`, `ipconfig /all`, `ping`, `nslookup`, check status/signal | Allowed automatically |
| 2 — Controlled change | `ipconfig /release` + `/renew`, `ipconfig /flushdns`, forget/rejoin Wi-Fi, disable/enable adapter, restart device | Explicit user "yes" required |
| 3 — High impact | Firewall rules, switch/router/AP config, VLANs, static IPs, registry edits | Blocked — escalate to admin |

## Level 2 commands (Windows, Command Prompt)

```
ipconfig /release
ipconfig /renew
```

```
ipconfig /flushdns
```

## Escalation contacts

| Issue | Contact | Hours |
|---|---|---|
| General network / Wi-Fi | <IT Help Desk ext. / email> | <Mon–Fri 9–5> |
| Area-wide outage | <Network Admin> | <...> |
| After hours emergency | <...> | <...> |

## Known issues

- <e.g. ISP link maintenance every Sunday 2–4 AM>
