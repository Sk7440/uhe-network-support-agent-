"""Agent loop: Ollama chat + tool calling, with logging and permission enforcement."""

import asyncio
import json
import re
import time
from typing import AsyncIterator

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import ollama_headers, settings
from .demo import SIMULATED_TOOLS, simulate
from .db import Approval, ChatSession, DiagnosticLog, Message, Ticket
from .tools import LEVEL2_ACTIONS, TOOLS, ToolError, validate_args

SYSTEM_PROMPT = settings.prompt_file.read_text(encoding="utf-8")

# Secrets typed by users are redacted before they are stored or sent to the model.
SECRET_RE = re.compile(
    r"(?i)\b(password|passwd|pwd|passcode|wifi\s*key|wi-fi\s*key|otp|pin|pass)\b(\s*(?:is|:|=|-)\s*)(\S+)"
)


def redact(text: str) -> tuple[str, bool]:
    new = SECRET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", text)
    return new, new != text


CLAIM_APPROVAL_RE = re.compile(
    r"(?is)\b(have sent|has been sent|sent a request|submitted|forwarded|requested|bhej d[ia]|bhej diya)\b.{0,80}\b(admin|administrator|approval)"
    r"|waiting for (the )?(it )?admin(istrator)?('s)? approval")
CLAIM_TICKET_RE = re.compile(r"(?is)\bticket\b.{0,60}\b(has been|have|was|is now)\s+(created|registered|raised|opened|logged)")


def unbacked_claim(text: str, used_tools: set[str]) -> str | None:
    """Detects when the model says it did an action without calling the tool."""
    if CLAIM_APPROVAL_RE.search(text) and "request_change" not in used_tools:
        return ("You told the user an approval request was sent, but you did NOT call request_change. "
                "Call request_change now if the change is justified, otherwise do not claim it.")
    if CLAIM_TICKET_RE.search(text) and "create_ticket" not in used_tools:
        return ("You told the user a ticket was created, but you did NOT call create_ticket. "
                "Call create_ticket now, then give the user the returned ticket ID.")
    return None


def event(kind: str, **data) -> dict:
    return {"type": kind, **data}


def _history(db: Session, session_id: str) -> list[dict]:
    rows = db.scalars(
        select(Message).where(Message.session_id == session_id).order_by(Message.id.desc()).limit(settings.history_limit)
    ).all()[::-1]
    # Don't start the window on an orphan tool message
    while rows and rows[0].role == "tool":
        rows = rows[1:]
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in rows:
        item = {"role": m.role, "content": m.content or ""}
        if m.tool_calls:
            item["tool_calls"] = m.tool_calls
        if m.role == "tool" and m.tool_name:
            item["tool_name"] = m.tool_name
        msgs.append(item)
    return msgs


def _summarize(name: str, result: dict) -> str:
    """Short human-readable line for the UI."""
    s = result.get("status")
    if s in ("error", "timeout", "blocked"):
        return result.get("error", s)
    if name == "check_ip_config":
        a = (result.get("active_adapters") or [{}])[0]
        if a.get("ipv4"):
            return f"{a.get('name')}: {a.get('ipv4')} · gateway {a.get('default_gateway') or 'none'}"
        return "No active adapter with an IPv4 address"
    if name == "ping_gateway":
        return f"{result.get('host')}: {result.get('received')}/{result.get('sent')} replies" + (
            f", {result['avg_latency_ms']} ms" if result.get("avg_latency_ms") is not None else "")
    if name == "check_internet":
        return result.get("verdict", "")
    if name == "check_dns":
        return f"{result.get('domain')} → " + (", ".join(result.get("addresses", [])[:2]) if result.get("resolved") else "failed to resolve")
    if name == "search_knowledge_base":
        return f"{len(result.get('results', []))} matching document section(s)"
    if name == "request_change":
        return f"Approval {result.get('approval_id')} waiting for IT admin"
    if name == "create_ticket":
        return f"Ticket {result.get('ticket_id')} registered ({result.get('ticket_status')})"
    return s or ""


async def _run_tool(db: Session, session_id: str, name: str, raw_args) -> tuple[dict, dict]:
    """Execute one tool call. Returns (result_for_model, ui_meta)."""
    tool = TOOLS.get(name)
    t0 = time.perf_counter()
    level = tool.level if tool else 3
    args: dict = {}
    extra_meta: dict = {}
    try:
        if not tool:
            raise PermissionError(f"Tool '{name}' does not exist or is not approved. Level 3 actions are blocked.")
        args = validate_args(tool, raw_args)

        if name == "request_change":
            approval = Approval(session_id=session_id, action=args["action"], level=2, reason=args.get("reason", ""))
            db.add(approval)
            db.commit()
            spec = LEVEL2_ACTIONS[args["action"]]
            result = {"status": "pending_approval", "approval_id": approval.id, "action": args["action"],
                      "label": spec["label"], "impact": spec["impact"],
                      "message": "Request sent to a human IT administrator. Nothing has been changed yet."}
            extra_meta["approval"] = {"id": approval.id, "action": args["action"], "label": spec["label"], "status": "pending"}

        elif name == "create_ticket":
            ticket = Ticket(session_id=session_id, status=args["status"], category=args["category"], priority=args["priority"],
                            summary=args["summary"], location=args.get("location", ""), connection_type=args.get("connection_type", ""),
                            steps_tried=args.get("steps_tried", ""), suspected_cause=args.get("suspected_cause", ""))
            db.add(ticket)
            db.commit()
            result = {"status": "success", "ticket_id": ticket.id, "ticket_status": ticket.status}
            extra_meta["ticket"] = {"id": ticket.id, "status": ticket.status, "priority": ticket.priority, "category": ticket.category}

        elif settings.diagnostics_mode == "demo" and name in SIMULATED_TOOLS:
            chat = db.get(ChatSession, session_id)
            result = await simulate(name, args, chat.scenario if chat else None, chat.fixed if chat else [])

        else:
            result = await asyncio.wait_for(tool.fn(**args), timeout=settings.tool_timeout + 15)

    except PermissionError as e:
        result = {"status": "blocked", "error": str(e)}
    except ToolError as e:
        result = {"status": "error", "error": f"Invalid input: {e}"}
    except (asyncio.TimeoutError, TimeoutError) as e:
        result = {"status": "timeout", "error": str(e) or "The tool timed out."}
    except Exception as e:  # unexpected tool failure must not crash the chat
        result = {"status": "error", "error": f"{type(e).__name__}: {e}"[:300]}

    duration = round((time.perf_counter() - t0) * 1000)
    db.add(DiagnosticLog(session_id=session_id, tool=name, level=level, arguments=args or {"raw": str(raw_args)[:300]},
                         status=result.get("status", "unknown"), result=result, duration_ms=duration))
    db.commit()
    meta = {"tool": name, "level": level, "status": result.get("status"), "duration_ms": duration,
            "summary": _summarize(name, result), "args": args, **extra_meta}
    return result, meta


async def run_agent(db: Session, session_id: str, user_text: str | None) -> AsyncIterator[dict]:
    """Runs one agent turn. Yields UI events. If user_text is None, continues after an admin decision."""
    chat = db.get(ChatSession, session_id)
    if user_text is not None:
        clean, was_redacted = redact(user_text)
        if was_redacted:
            yield event("redacted", message="A password/secret was removed from your message. Never share credentials here.")
        db.add(Message(session_id=session_id, role="user", content=clean))
        if chat and chat.title == "New conversation":
            chat.title = clean[:80]
        db.commit()

    tools_schema = [t.schema() for t in TOOLS.values()]
    used_tools: set[str] = set()
    corrected = False
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10), headers=ollama_headers()) as client:
        for _round in range(settings.max_tool_rounds):
            payload = {
                "model": settings.chat_model,
                "messages": _history(db, session_id),
                "tools": tools_schema,
                "stream": True,
                "think": False,
                "options": {"temperature": settings.temperature, "num_predict": settings.max_tokens},
            }
            content, tool_calls = "", []
            try:
                async with client.stream("POST", f"{settings.ollama_url}/api/chat", json=payload) as r:
                    if r.status_code != 200:
                        body = (await r.aread()).decode(errors="ignore")[:300]
                        yield event("error", message=f"AI model error ({r.status_code}): {body}")
                        return
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        chunk = json.loads(line)
                        if chunk.get("error"):
                            yield event("error", message=f"AI model error: {chunk['error']}")
                            return
                        msg = chunk.get("message", {})
                        if msg.get("content"):
                            content += msg["content"]
                            yield event("token", text=msg["content"])
                        if msg.get("tool_calls"):
                            tool_calls.extend(msg["tool_calls"])
            except httpx.HTTPError as e:
                yield event("error", message=f"Cannot reach the AI service ({type(e).__name__}). Please try again shortly.")
                return

            if not tool_calls and not corrected:
                problem = unbacked_claim(content, used_tools)
                if problem:
                    # Discard the false claim and make the model act properly.
                    corrected = True
                    yield event("retract")
                    db.add(Message(session_id=session_id, role="system", content=problem, meta={"hidden": True}))
                    db.commit()
                    continue

            db.add(Message(session_id=session_id, role="assistant", content=content, tool_calls=tool_calls or None))
            db.commit()
            if not tool_calls:
                yield event("done")
                return

            for call in tool_calls:
                fn = call.get("function", {})
                name, args = fn.get("name", ""), fn.get("arguments", {})
                call_id = call.get("id") or f"{name}-{time.time_ns()}"
                level = TOOLS[name].level if name in TOOLS else 3
                used_tools.add(name)
                yield event("tool_start", id=call_id, tool=name, level=level)
                result, meta = await _run_tool(db, session_id, name, args)
                db.add(Message(session_id=session_id, role="tool", tool_name=name,
                               content=json.dumps(result, ensure_ascii=False)[:8000], meta=meta))
                db.commit()
                yield event("tool_end", id=call_id, **meta)

        yield event("error", message="I ran many checks without reaching a conclusion. Let me hand this to a technician — please describe the problem again or ask for escalation.")
