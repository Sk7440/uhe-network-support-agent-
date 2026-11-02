"""UHE Network Support Agent — FastAPI backend."""

import hmac
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .agent import run_agent
from .config import ollama_headers, settings
from .demo import SCENARIOS
from .db import Approval, ChatSession, DiagnosticLog, Message, SessionLocal, Ticket, get_db, init_db
from .tools import KB, LEVEL2_ACTIONS, execute_level2


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    try:
        n = await KB.build()
        print(f"[startup] knowledge base: {n} sections indexed")
    except Exception as e:
        print(f"[startup] knowledge base NOT loaded ({e}); agent still works")
    if not settings.admin_token:
        print("[startup] WARNING: ADMIN_TOKEN is not set — admin endpoints are disabled.")
    yield


app = FastAPI(title="UHE Network Support Agent", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.frontend_origins,
    allow_origin_regex=settings.frontend_origin_regex or None,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Content-Type", "X-Admin-Token"],
)


# ------------------------------------------------------------------ schemas
class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=6000)


class SessionIn(BaseModel):
    scenario: str | None = None


class DecisionIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=500)


class TicketPatch(BaseModel):
    status: str = Field(pattern="^(escalated|resolved|closed)$")


def require_admin(x_admin_token: str = Header(default="")):
    if not settings.admin_token:
        raise HTTPException(503, "Admin access is disabled: set ADMIN_TOKEN in backend/.env")
    if not hmac.compare_digest(x_admin_token, settings.admin_token):
        raise HTTPException(401, "Invalid admin token")


def iso(d: datetime | None):
    if not d:
        return None
    if d.tzinfo is None:  # SQLite drops the timezone; values are stored in UTC
        d = d.replace(tzinfo=timezone.utc)
    return d.isoformat()


def sse(gen):
    async def stream():
        try:
            async for ev in gen:
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as e:  # never leave the client hanging
            yield f"data: {json.dumps({'type': 'error', 'message': f'Server error: {type(e).__name__}'})}\n\n"
    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def get_session_or_404(db: Session, sid: str) -> ChatSession:
    s = db.get(ChatSession, sid)
    if not s:
        raise HTTPException(404, "Session not found")
    return s


# ------------------------------------------------------------------ public
@app.get("/api/health")
async def health():
    demo = settings.diagnostics_mode == "demo"
    out = {"api": True, "model": settings.chat_model, "kb_sections": len(KB.chunks),
           "level2_execution": settings.allow_level2_execution or demo,
           "diagnostics_mode": settings.diagnostics_mode,
           "scenarios": [{"id": k, **{f: v[f] for f in ("label", "description", "opening")}} for k, v in SCENARIOS.items()] if demo else []}
    try:
        async with httpx.AsyncClient(timeout=8, headers=ollama_headers()) as c:
            r = await c.get(f"{settings.ollama_url}/api/tags")
            r.raise_for_status()
            names = [m.get("name", "") for m in r.json().get("models", [])]
        out["ollama"] = True
        base = settings.chat_model.removesuffix("-cloud")
        out["model_available"] = any(n.startswith(base) for n in names) or bool(settings.ollama_api_key)
    except Exception:
        out["ollama"] = False
        out["model_available"] = False
    return out


@app.post("/api/sessions", status_code=201)
def create_session(body: SessionIn | None = None, db: Session = Depends(get_db)):
    scenario = None
    if settings.diagnostics_mode == "demo":
        scenario = body.scenario if body and body.scenario in SCENARIOS else "healthy"
    s = ChatSession(scenario=scenario, fixed=[])
    db.add(s)
    db.commit()
    return {"id": s.id}


@app.get("/api/sessions/{sid}")
def get_session(sid: str, db: Session = Depends(get_db)):
    s = get_session_or_404(db, sid)
    msgs = db.scalars(select(Message).where(Message.session_id == sid).order_by(Message.id)).all()
    items = []
    for m in msgs:
        if m.role == "user":
            items.append({"kind": "user", "text": m.content})
        elif m.role == "assistant" and m.content.strip():
            items.append({"kind": "assistant", "text": m.content})
        elif m.role == "tool" and m.meta:
            items.append({"kind": "tool", **m.meta})
        elif m.role == "system" and not (m.meta or {}).get("hidden"):
            items.append({"kind": "notice", "text": m.content})
    # refresh live approval status for the UI
    for it in items:
        if it.get("approval"):
            a = db.get(Approval, it["approval"]["id"])
            if a:
                it["approval"]["status"] = a.status
    return {"id": s.id, "title": s.title, "scenario": s.scenario, "items": items}


@app.post("/api/sessions/{sid}/chat")
async def chat(sid: str, body: ChatIn):
    db = SessionLocal()
    get_session_or_404(db, sid)

    async def gen():
        try:
            async for ev in run_agent(db, sid, body.message):
                yield ev
        finally:
            db.close()
    return sse(gen())


@app.post("/api/sessions/{sid}/continue")
async def continue_after_decision(sid: str):
    """Lets the agent react to an admin decision (no new user message)."""
    db = SessionLocal()
    get_session_or_404(db, sid)
    last = db.scalars(select(Message).where(Message.session_id == sid).order_by(Message.id.desc()).limit(1)).first()
    if not last or last.role != "system":
        db.close()
        raise HTTPException(409, "Nothing to continue")

    async def gen():
        try:
            async for ev in run_agent(db, sid, None):
                yield ev
        finally:
            db.close()
    return sse(gen())


@app.get("/api/approvals/{aid}")
def approval_status(aid: str, db: Session = Depends(get_db)):
    a = db.get(Approval, aid)
    if not a:
        raise HTTPException(404, "Approval not found")
    return {"id": a.id, "action": a.action, "status": a.status, "admin_note": a.admin_note}


# ------------------------------------------------------------------ admin
admin = [Depends(require_admin)]


@app.get("/api/admin/stats", dependencies=admin)
def stats(db: Session = Depends(get_db)):
    count = lambda q: db.scalar(q) or 0
    return {
        "sessions": count(select(func.count(ChatSession.id))),
        "pending_approvals": count(select(func.count(Approval.id)).where(Approval.status == "pending")),
        "tickets_escalated": count(select(func.count(Ticket.id)).where(Ticket.status == "escalated")),
        "tickets_resolved": count(select(func.count(Ticket.id)).where(Ticket.status == "resolved")),
        "diagnostics_run": count(select(func.count(DiagnosticLog.id))),
        "tool_failures": count(select(func.count(DiagnosticLog.id)).where(DiagnosticLog.status.in_(["error", "timeout", "blocked"]))),
    }


@app.get("/api/admin/approvals", dependencies=admin)
def list_approvals(status: str | None = Query(default=None), db: Session = Depends(get_db)):
    q = select(Approval).order_by(Approval.created_at.desc()).limit(200)
    if status:
        q = q.where(Approval.status == status)
    return [{"id": a.id, "session_id": a.session_id, "action": a.action, "label": LEVEL2_ACTIONS.get(a.action, {}).get("label", a.action),
             "impact": LEVEL2_ACTIONS.get(a.action, {}).get("impact", ""), "reason": a.reason, "status": a.status,
             "admin_note": a.admin_note, "result": a.result, "created_at": iso(a.created_at), "decided_at": iso(a.decided_at)}
            for a in db.scalars(q).all()]


@app.post("/api/admin/approvals/{aid}/decision", dependencies=admin)
def decide(aid: str, body: DecisionIn, db: Session = Depends(get_db)):
    a = db.get(Approval, aid)
    if not a:
        raise HTTPException(404, "Approval not found")
    if a.status != "pending":
        raise HTTPException(409, f"Already decided ({a.status})")

    if body.approve and settings.diagnostics_mode == "demo":
        result = {"status": "executed", "simulated": True,
                  "outputs": [{"command": " ".join(c), "output": "(simulated) completed successfully"} for c in LEVEL2_ACTIONS[a.action]["commands"]]}
        a.status = "executed"
        chat = db.get(ChatSession, a.session_id)
        if chat:
            chat.fixed = list({*(chat.fixed or []), a.action})
    elif body.approve:
        result = execute_level2(a.action)
        a.status = result["status"]  # executed | dry_run | failed
    else:
        result = {"status": "denied"}
        a.status = "denied"
    a.result, a.admin_note, a.decided_at = result, body.note, datetime.now(timezone.utc)
    db.add(DiagnosticLog(session_id=a.session_id, tool=f"level2:{a.action}", level=2, arguments={"approval_id": a.id},
                         status=a.status, result=result, actor="admin"))

    label = LEVEL2_ACTIONS[a.action]["label"]
    if a.status == "executed":
        note = f"The change '{label}' was EXECUTED on the user's device. Re-run Level 1 checks to verify the fix."
    elif a.status == "dry_run":
        cmds = "; ".join(result.get("commands", []))
        note = (f"The change '{label}' was APPROVED but automatic execution is disabled. "
                f"Guide the user to run it manually in Command Prompt: {cmds}. Then re-run Level 1 checks.")
    elif a.status == "failed":
        note = f"The change '{label}' was approved but FAILED: {result.get('error')}. Consider escalation."
    else:
        note = f"The change '{label}' was DENIED by the administrator." + (f" Note: {body.note}" if body.note else "") + \
               " Do not perform it. Continue diagnosis or escalate."
    if body.note and a.status != "denied":
        note += f" Admin note: {body.note}"
    db.add(Message(session_id=a.session_id, role="system", content=f"ADMIN DECISION ({a.id}): {note}"))
    db.commit()
    return {"id": a.id, "status": a.status, "result": result}


@app.get("/api/admin/tickets", dependencies=admin)
def list_tickets(db: Session = Depends(get_db)):
    rows = db.scalars(select(Ticket).order_by(Ticket.created_at.desc()).limit(300)).all()
    return [{c: (iso(getattr(t, c)) if c.endswith("_at") else getattr(t, c)) for c in
             ("id", "session_id", "status", "category", "priority", "summary", "location", "connection_type",
              "steps_tried", "suspected_cause", "created_at", "updated_at")} for t in rows]


@app.patch("/api/admin/tickets/{tid}", dependencies=admin)
def update_ticket(tid: str, body: TicketPatch, db: Session = Depends(get_db)):
    t = db.get(Ticket, tid)
    if not t:
        raise HTTPException(404, "Ticket not found")
    t.status = body.status
    db.commit()
    return {"id": t.id, "status": t.status}


@app.get("/api/admin/logs", dependencies=admin)
def list_logs(session_id: str | None = None, limit: int = Query(default=200, le=1000), db: Session = Depends(get_db)):
    q = select(DiagnosticLog).order_by(DiagnosticLog.id.desc()).limit(limit)
    if session_id:
        q = q.where(DiagnosticLog.session_id == session_id)
    return [{"id": l.id, "session_id": l.session_id, "tool": l.tool, "level": l.level, "arguments": l.arguments,
             "status": l.status, "result": l.result, "duration_ms": l.duration_ms, "actor": l.actor,
             "created_at": iso(l.created_at)} for l in db.scalars(q).all()]


@app.get("/api/admin/sessions/{sid}", dependencies=admin)
def admin_session(sid: str, db: Session = Depends(get_db)):
    return get_session(sid, db)
