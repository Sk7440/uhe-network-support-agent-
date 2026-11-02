"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamAgent, toolLabel, type AgentEvent, type ChatItem, type Health, type Scenario, type ToolItem } from "@/lib/api";
import { LevelBadge, Logo, Markdown, Spinner, StatusPill } from "./ui";

const SESSION_KEY = "uhe-net-session";

const SUGGESTIONS = [
  { tag: "Wi-Fi", text: "Wi-Fi connected hai lekin internet nahi chal raha" },
  { tag: "LAN", text: "My LAN cable is plugged in but there's no internet" },
  { tag: "IP address", text: "My IP address starts with 169.254 — what does that mean?" },
  { tag: "DNS", text: "Some websites don't open but WhatsApp works" },
  { tag: "Speed", text: "Internet is very slow in my department" },
  { tag: "Outage", text: "Nobody on our floor has internet" },
];

let keySeq = 0;
const newKey = () => `k${Date.now()}-${keySeq++}`;

function fromServer(raw: Array<Record<string, unknown>>): ChatItem[] {
  return raw.map((r) => {
    const key = newKey();
    if (r.kind === "tool") return { ...(r as unknown as ToolItem), kind: "tool", key };
    if (r.kind === "notice") return { kind: "notice", key, text: String(r.text).replace(/^ADMIN DECISION \([^)]*\):\s*/, "IT admin decision: "), tone: "info" };
    return { kind: r.kind as "user" | "assistant", key, text: String(r.text) };
  });
}

export default function Chat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scenario, setScenario] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const handledApprovals = useRef<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* ---------- health ---------- */
  useEffect(() => {
    const check = () =>
      api.health().then((h) => { setHealth(h); setHealthError(false); }).catch(() => setHealthError(true));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  /* ---------- restore session ---------- */
  useEffect(() => {
    const sid = localStorage.getItem(SESSION_KEY);
    if (!sid) return;
    api.getSession(sid)
      .then((s) => {
        setSessionId(s.id);
        setScenario(s.scenario);
        const restored = fromServer(s.items);
        restored.forEach((it) => {
          if (it.kind === "tool" && it.approval && it.approval.status !== "pending") handledApprovals.current.add(it.approval.id);
        });
        setItems(restored);
      })
      .catch(() => localStorage.removeItem(SESSION_KEY));
  }, []);

  /* ---------- autoscroll ---------- */
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (near || busy) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  /* ---------- event handling ---------- */
  const applyEvent = useCallback((e: AgentEvent) => {
    setItems((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      switch (e.type) {
        case "token":
          if (last?.kind === "assistant" && last.streaming) next[next.length - 1] = { ...last, text: last.text + e.text };
          else next.push({ kind: "assistant", key: newKey(), text: e.text, streaming: true });
          break;
        case "retract":
          if (last?.kind === "assistant" && last.streaming) next.pop();
          break;
        case "tool_start":
          if (last?.kind === "assistant" && last.streaming && !last.text.trim()) next.pop();
          next.push({ kind: "tool", key: e.id, tool: e.tool, level: e.level, status: "running" });
          break;
        case "tool_end": {
          const i = next.findIndex((x) => x.kind === "tool" && x.key === e.id);
          const { type: _t, id: _id, ...rest } = e;
          const updated: ToolItem = { kind: "tool", key: e.id, ...rest };
          if (i >= 0) next[i] = updated;
          else next.push(updated);
          break;
        }
        case "redacted":
          next.push({ kind: "notice", key: newKey(), text: e.message, tone: "warn" });
          break;
        case "error":
          next.push({ kind: "notice", key: newKey(), text: e.message, tone: "error" });
          break;
      }
      return next;
    });
  }, []);

  const finishStream = useCallback(() => {
    setItems((prev) =>
      prev
        .filter((x) => !(x.kind === "assistant" && x.streaming && !x.text.trim()))
        .map((x) => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x)),
    );
  }, []);

  const run = useCallback(
    async (path: string, body: unknown) => {
      setBusy(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await streamAgent(path, body, applyEvent, ctrl.signal);
      } catch (err) {
        if ((err as Error).name !== "AbortError")
          applyEvent({ type: "error", message: (err as Error).message || "Connection to the support server failed." });
      } finally {
        finishStream();
        setBusy(false);
        abortRef.current = null;
      }
    },
    [applyEvent, finishStream],
  );

  const send = useCallback(
    async (raw?: string, pickScenario?: string) => {
      const text = (raw ?? input).trim();
      if (!text || busy) return;
      setInput("");
      let sid = sessionId;
      try {
        if (!sid) {
          const sc = pickScenario ?? (health?.diagnostics_mode === "demo" ? "healthy" : undefined);
          sid = (await api.createSession(sc)).id;
          setScenario(sc ?? null);
          setSessionId(sid);
          localStorage.setItem(SESSION_KEY, sid);
        }
      } catch {
        setItems((p) => [...p, { kind: "notice", key: newKey(), text: "Cannot reach the support server. Please check it is running.", tone: "error" }]);
        return;
      }
      setItems((p) => [...p, { kind: "user", key: newKey(), text }, { kind: "assistant", key: newKey(), text: "", streaming: true }]);
      await run(`/api/sessions/${sid}/chat`, { message: text });
      textareaRef.current?.focus();
    },
    [input, busy, sessionId, run, health],
  );

  /* ---------- poll pending approvals ---------- */
  const pending = items.filter((x): x is ToolItem => x.kind === "tool" && x.approval?.status === "pending");
  const pendingIds = pending.map((p) => p.approval!.id).join(",");

  useEffect(() => {
    if (!pendingIds || !sessionId) return;
    const t = setInterval(async () => {
      for (const id of pendingIds.split(",")) {
        if (handledApprovals.current.has(id)) continue;
        try {
          const a = await api.approval(id);
          if (a.status === "pending") continue;
          handledApprovals.current.add(id);
          setItems((prev) =>
            prev.map((x) => (x.kind === "tool" && x.approval?.id === id ? { ...x, approval: { ...x.approval!, status: a.status } } : x)),
          );
          const verdict =
            a.status === "denied" ? "denied the request" : a.status === "failed" ? "approved, but the change failed" : "approved the request";
          setItems((p) => [...p, { kind: "notice", key: newKey(), text: `IT admin ${verdict}${a.admin_note ? ` — "${a.admin_note}"` : ""}.`, tone: "info" }]);
          if (!abortRef.current) await run(`/api/sessions/${sessionId}/continue`, undefined);
        } catch {}
      }
    }, 3000);
    return () => clearInterval(t);
  }, [pendingIds, sessionId, run]);

  const newChat = () => {
    abortRef.current?.abort();
    localStorage.removeItem(SESSION_KEY);
    setSessionId(null);
    setScenario(null);
    setItems([]);
    handledApprovals.current.clear();
    textareaRef.current?.focus();
  };

  const online = health?.ollama && health?.model_available;
  const demo = health?.diagnostics_mode === "demo";
  const scenarioInfo = health?.scenarios.find((x) => x.id === scenario);
  const toolsRun = items.filter((x): x is ToolItem => x.kind === "tool");
  const tickets = toolsRun.filter((t) => t.ticket);
  const approvals = toolsRun.filter((t) => t.approval);

  /* ---------- render ---------- */
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 bg-brand px-4 py-3 text-white sm:px-6">
        <Logo />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold">UHE Network Support Agent</h1>
          <p className="hidden truncate text-xs text-sky-100/80 sm:block">University of Home Economics, Lahore · IT Support</p>
        </div>
        {demo && (
          <span className="hidden rounded-full bg-amber-400/90 px-2.5 py-1 text-[11px] font-semibold text-amber-950 md:inline" title="Diagnostics use a simulated device">
            DEMO{scenarioInfo ? ` · ${scenarioInfo.label}` : ""}
          </span>
        )}
        <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs" title={health ? `${health.model}` : ""}>
          <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,.25)]" : healthError || health ? "bg-rose-400" : "bg-slate-400"}`} />
          <span className="hidden sm:inline">{online ? "Agent online" : healthError ? "Server offline" : health ? "Model unavailable" : "Connecting…"}</span>
        </div>
        <button onClick={newChat} className="rounded-lg border border-white/25 px-3 py-1.5 text-[13px] hover:bg-white/10">
          New chat
        </button>
        <Link href="/admin" className="hidden rounded-lg px-2 py-1.5 text-[13px] text-sky-100/80 hover:text-white sm:block">
          IT Admin
        </Link>
      </header>

      <div className="flex min-h-0 flex-1">
        <main ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 pb-6 pt-6 sm:px-6">
            {items.length === 0 ? (
              <Welcome onPick={send} scenarios={demo ? health!.scenarios : []} />
            ) : (
              <Thread items={items} busy={busy} />
            )}
          </div>
        </main>

        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-line bg-white px-5 py-6 lg:block">
          <SidePanel health={health} scenario={scenarioInfo} toolsRun={toolsRun} tickets={tickets} approvals={approvals} />
        </aside>
      </div>

      <footer className="border-t border-line bg-white">
        <div className="mx-auto max-w-3xl px-4 pb-3 pt-3 sm:px-6">
          <div className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white py-1.5 pl-4 pr-1.5 focus-within:border-brand-2 focus-within:ring-4 focus-within:ring-brand-2/10">
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Describe your network problem…"
              aria-label="Message"
              className="max-h-40 flex-1 resize-none bg-transparent py-2 text-[15px] outline-none placeholder:text-ink-3"
            />
            {busy ? (
              <button onClick={() => abortRef.current?.abort()} aria-label="Stop" className="grid h-10 w-10 place-items-center rounded-xl bg-rose-600 text-white">
                <span className="h-3.5 w-3.5 rounded-sm bg-white" />
              </button>
            ) : (
              <button onClick={() => send()} disabled={!input.trim()} aria-label="Send" className="grid h-10 w-10 place-items-center rounded-xl bg-brand text-white disabled:bg-slate-300">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            )}
          </div>
          <p className="mt-2 text-center text-[11.5px] text-ink-3">
            🔒 Never share passwords or OTPs. Read-only checks run automatically; any change needs IT admin approval.
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ================================================================== pieces */

function Welcome({ onPick, scenarios }: { onPick: (t: string, scenario?: string) => void; scenarios: Scenario[] }) {
  if (scenarios.length)
    return (
      <section className="pt-6">
        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11.5px] font-semibold text-amber-800 ring-1 ring-amber-200">Demo mode</span>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight">Pick a device problem to simulate</h2>
        <p className="mt-2 max-w-xl text-ink-2">
          The agent runs its diagnostic tools against a simulated laptop with this fault, then diagnoses, requests admin approval for fixes,
          verifies, and registers a ticket — exactly like on a real device.
        </p>
        <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
          {scenarios.map((s) => (
            <button
              key={s.id}
              onClick={() => onPick(s.opening, s.id)}
              className="group rounded-xl border border-line bg-white px-4 py-3 text-left transition hover:-translate-y-px hover:border-brand-2"
            >
              <span className="block text-[14px] font-semibold">{s.label}</span>
              <span className="block text-[12.5px] text-ink-2">{s.description}</span>
              <span className="mt-2 block truncate text-[12px] italic text-ink-3 group-hover:text-brand-2">“{s.opening}”</span>
            </button>
          ))}
        </div>
        <p className="mt-4 text-[12.5px] text-ink-3">Or type your own message below — it uses a healthy simulated device.</p>
      </section>
    );
  return (
    <section className="pt-6">
      <h2 className="text-2xl font-semibold tracking-tight">Network problem? Let&apos;s diagnose it.</h2>
      <p className="mt-2 max-w-xl text-ink-2">
        I run safe, read-only checks on your connection, explain what I find, and hand anything bigger to the UHE IT team. English, Urdu or Roman Urdu.
      </p>
      <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.text}
            onClick={() => onPick(s.text)}
            className="rounded-xl border border-line bg-white px-4 py-3 text-left text-[14px] transition hover:-translate-y-px hover:border-brand-2"
          >
            <span className="block text-[11.5px] font-medium uppercase tracking-wide text-ink-3">{s.tag}</span>
            {s.text}
          </button>
        ))}
      </div>
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {[
          { l: 1, t: "Automatic checks", d: "IP config, gateway ping, internet & DNS tests." },
          { l: 2, t: "Approved fixes", d: "IP renew or DNS flush only after an IT admin approves." },
          { l: 3, t: "Escalated", d: "Firewall & router changes go to a human technician." },
        ].map((x) => (
          <div key={x.l} className="rounded-xl bg-white/60 p-3 ring-1 ring-line">
            <LevelBadge level={x.l} />
            <p className="mt-2 text-[13.5px] font-medium">{x.t}</p>
            <p className="text-[12.5px] text-ink-2">{x.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Thread({ items, busy }: { items: ChatItem[]; busy: boolean }) {
  // Group consecutive plain diagnostic tools into one box
  const blocks: Array<{ type: "tools"; tools: ToolItem[]; key: string } | { type: "item"; item: ChatItem }> = [];
  for (const it of items) {
    const plainTool = it.kind === "tool" && !it.approval && !it.ticket;
    const lastBlock = blocks[blocks.length - 1];
    if (plainTool) {
      if (lastBlock?.type === "tools") lastBlock.tools.push(it as ToolItem);
      else blocks.push({ type: "tools", tools: [it as ToolItem], key: it.key });
    } else blocks.push({ type: "item", item: it });
  }

  return (
    <div className="space-y-4">
      {blocks.map((b) =>
        b.type === "tools" ? <ToolGroup key={b.key} tools={b.tools} /> : <Item key={b.item.key} item={b.item} />,
      )}
      {busy && items[items.length - 1]?.kind !== "assistant" && items[items.length - 1]?.kind !== "tool" && (
        <div className="ml-11 dot-typing"><span /><span /><span /></div>
      )}
    </div>
  );
}

function BotAvatar() {
  return (
    <div className="mt-0.5 hidden h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand sm:grid">
      <svg width="18" height="18" viewBox="0 0 32 32"><path d="M7 13a12 12 0 0 1 18 0M10.5 17a7 7 0 0 1 11 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" /><circle cx="16" cy="22" r="2.4" fill="#38bdf8" /></svg>
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  if (item.kind === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-2 px-4 py-2.5 text-[14.5px] text-white">{item.text}</div>
      </div>
    );

  if (item.kind === "assistant")
    return (
      <div className="flex gap-3">
        <BotAvatar />
        <div className="min-w-0 max-w-[88%] rounded-2xl rounded-tl-md border border-line bg-white px-4 py-3">
          {item.text ? <Markdown text={item.text} /> : <div className="dot-typing py-1"><span /><span /><span /></div>}
        </div>
      </div>
    );

  if (item.kind === "notice") {
    const tone =
      item.tone === "error" ? "bg-rose-50 text-rose-800 ring-rose-200" : item.tone === "warn" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-sky-50 text-sky-900 ring-sky-200";
    return <div className={`mx-auto max-w-xl rounded-lg px-3 py-2 text-center text-[13px] ring-1 ${tone}`}>{item.text}</div>;
  }

  // tool with approval or ticket
  if (item.approval) return <ApprovalCard tool={item} />;
  if (item.ticket) return <TicketCard tool={item} />;
  return <ToolGroup tools={[item]} />;
}

function ToolIcon({ status }: { status: string }) {
  if (status === "running") return <Spinner className="h-4 w-4 text-brand-2" />;
  if (status === "success")
    return <svg className="h-4 w-4 text-emerald-600" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" clipRule="evenodd" /></svg>;
  return <svg className="h-4 w-4 text-rose-600" viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-.9 4h1.8v5H9.1V6Zm0 6.5h1.8v1.8H9.1v-1.8Z" /></svg>;
}

function ToolGroup({ tools }: { tools: ToolItem[] }) {
  return (
    <div className="ml-0 rounded-xl border border-dashed border-slate-300 bg-white/60 px-3 py-2 sm:ml-11">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Diagnostics</p>
      <ul className="divide-y divide-line">
        {tools.map((t) => (
          <li key={t.key} className="flex items-start gap-2.5 py-1.5">
            <span className="mt-0.5"><ToolIcon status={t.status} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[13.5px] font-medium">{toolLabel(t.tool)}</span>
                <LevelBadge level={t.level} />
                {t.duration_ms !== undefined && <span className="text-[11px] text-ink-3">{(t.duration_ms / 1000).toFixed(1)}s</span>}
              </div>
              {t.summary && <p className="truncate font-mono text-[12px] text-ink-2" title={t.summary}>{t.summary}</p>}
              {t.status === "running" && <p className="text-[12px] text-ink-3">Running…</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApprovalCard({ tool }: { tool: ToolItem }) {
  const a = tool.approval!;
  const pending = a.status === "pending";
  const ok = a.status === "executed" || a.status === "dry_run";
  return (
    <div className={`ml-0 rounded-xl border px-4 py-3 sm:ml-11 ${pending ? "border-amber-200 bg-amber-50" : ok ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}>
      <div className="flex items-center gap-2">
        {pending ? <Spinner className="h-4 w-4 text-amber-600" /> : <ToolIcon status={ok ? "success" : "error"} />}
        <span className="text-[14px] font-semibold">
          {pending ? "Waiting for IT administrator approval" : ok ? "Approved by IT administrator" : a.status === "denied" ? "Denied by IT administrator" : "Change failed"}
        </span>
        <LevelBadge level={2} />
      </div>
      <p className="mt-1 text-[13px] text-ink-2">
        {a.label} · <span className="font-mono">{a.id}</span>
      </p>
      {pending && <p className="mt-1 text-[12px] text-ink-3">Nothing has been changed yet. This updates automatically.</p>}
    </div>
  );
}

function TicketCard({ tool }: { tool: ToolItem }) {
  const t = tool.ticket!;
  const resolved = t.status === "resolved";
  return (
    <div className={`ml-0 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 sm:ml-11 ${resolved ? "border-emerald-200 bg-emerald-50" : "border-orange-200 bg-orange-50"}`}>
      <span className="text-xl">{resolved ? "✅" : "🛠️"}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">{resolved ? "Resolution recorded" : "Escalated to UHE IT"}</p>
        <p className="text-[13px] text-ink-2">
          Ticket <span className="font-mono font-semibold text-ink">{t.id}</span> · {t.category.replace(/_/g, " ")}
        </p>
      </div>
      <StatusPill status={t.priority} />
      <StatusPill status={t.status} />
    </div>
  );
}

function SidePanel({ health, scenario, toolsRun, tickets, approvals }: { health: Health | null; scenario?: Scenario; toolsRun: ToolItem[]; tickets: ToolItem[]; approvals: ToolItem[] }) {
  const checks = toolsRun.filter((t) => !t.ticket && !t.approval);
  return (
    <div className="space-y-6 text-[13px]">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Agent</h3>
        <dl className="space-y-1.5">
          <Row k="Model" v={health?.model ?? "—"} mono />
          <Row k="Knowledge base" v={health ? `${health.kb_sections} sections` : "—"} />
          <Row k="Level 2 mode" v={health ? (health.level2_execution ? "Auto-execute after approval" : "Guided (manual)") : "—"} />
          <Row k="Diagnostics" v={health ? (health.diagnostics_mode === "demo" ? "Simulated device" : "This computer") : "—"} />
          {scenario && <Row k="Scenario" v={scenario.label} />}
        </dl>
      </section>
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">This session</h3>
        {checks.length === 0 ? (
          <p className="text-ink-3">No checks run yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {checks.map((t) => (
              <li key={t.key} className="flex items-center gap-2">
                <ToolIcon status={t.status} />
                <span className="truncate">{toolLabel(t.tool)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {approvals.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Approvals</h3>
          <ul className="space-y-1.5">
            {approvals.map((a) => (
              <li key={a.key} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[12px]">{a.approval!.id}</span>
                <StatusPill status={a.approval!.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {tickets.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Tickets</h3>
          <ul className="space-y-1.5">
            {tickets.map((t) => (
              <li key={t.key} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[12px]">{t.ticket!.id}</span>
                <StatusPill status={t.ticket!.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-3">{k}</dt>
      <dd className={`truncate text-right ${mono ? "font-mono text-[12px]" : ""}`}>{v}</dd>
    </div>
  );
}
