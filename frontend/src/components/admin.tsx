"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  adminApi, timeAgo, toolLabel,
  type AdminApproval, type AdminLog, type AdminStats, type AdminTicket,
} from "@/lib/api";
import { LevelBadge, Logo, Markdown, Spinner, StatusPill } from "./ui";

const TOKEN_KEY = "uhe-admin-token";
type Tab = "approvals" | "tickets" | "logs";

export default function AdminDashboard() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(sessionStorage.getItem(TOKEN_KEY));
    setReady(true);
  }, []);

  if (!ready) return null;
  if (!token)
    return (
      <Login
        onLogin={(t) => {
          sessionStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  return (
    <Dashboard
      token={token}
      onLogout={() => {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }}
    />
  );
}

/* ------------------------------------------------------------------ login */
function Login({ onLogin }: { onLogin: (t: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await adminApi(value.trim()).stats();
      onLogin(value.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid h-full place-items-center bg-brand px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-lg bg-brand p-0.5"><Logo className="h-8 w-8" /></div>
          <div>
            <h1 className="font-semibold">UHE IT Admin Console</h1>
            <p className="text-[12.5px] text-ink-3">Network Support Agent</p>
          </div>
        </div>
        <label className="text-[13px] font-medium text-ink-2" htmlFor="token">Admin access token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-[14px] outline-none focus:border-brand-2 focus:ring-4 focus:ring-brand-2/10"
        />
        <p className="mt-1.5 text-[12px] text-ink-3">Set as ADMIN_TOKEN in backend/.env</p>
        {error && <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-[13px] text-rose-700">{error}</p>}
        <button disabled={!value.trim() || loading} className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-2.5 text-[14px] font-medium text-white disabled:opacity-60">
          {loading && <Spinner />} Sign in
        </button>
        <Link href="/" className="mt-4 block text-center text-[13px] text-ink-3 hover:text-ink">← Back to assistant</Link>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ dashboard */
function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const client = useMemo(() => adminApi(token), [token]);
  const [tab, setTab] = useState<Tab>("approvals");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [approvals, setApprovals] = useState<AdminApproval[]>([]);
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [logs, setLogs] = useState<AdminLog[]>([]);
  const [error, setError] = useState("");
  const [sessionView, setSessionView] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, a, t, l] = await Promise.all([client.stats(), client.approvals(), client.tickets(), client.logs()]);
      setStats(s); setApprovals(a); setTickets(t); setLogs(l); setError(""); setUpdated(new Date());
    } catch (e) {
      const msg = (e as Error).message;
      if (/token/i.test(msg)) onLogout();
      else setError(msg);
    }
  }, [client, onLogout]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const pending = approvals.filter((a) => a.status === "pending");

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 bg-brand px-4 py-3 text-white sm:px-6">
        <Logo />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold">UHE IT Admin Console</h1>
          <p className="hidden text-xs text-sky-100/80 sm:block">
            Network Support Agent{updated ? ` · updated ${updated.toLocaleTimeString()}` : ""}
          </p>
        </div>
        <Link href="/" className="rounded-lg border border-white/25 px-3 py-1.5 text-[13px] hover:bg-white/10">Open assistant</Link>
        <button onClick={onLogout} className="rounded-lg px-2 py-1.5 text-[13px] text-sky-100/80 hover:text-white">Sign out</button>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          {error && <p className="mb-4 rounded-lg bg-rose-50 px-4 py-2 text-[13px] text-rose-700 ring-1 ring-rose-200">{error}</p>}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Stat label="Pending approvals" value={stats?.pending_approvals} accent={!!stats?.pending_approvals} />
            <Stat label="Escalated tickets" value={stats?.tickets_escalated} />
            <Stat label="Resolved by agent" value={stats?.tickets_resolved} />
            <Stat label="Conversations" value={stats?.sessions} />
            <Stat label="Diagnostics run" value={stats?.diagnostics_run} />
            <Stat label="Tool failures" value={stats?.tool_failures} />
          </div>

          <nav className="mt-6 flex gap-1 border-b border-line">
            {([
              ["approvals", `Approvals${pending.length ? ` (${pending.length})` : ""}`],
              ["tickets", "Tickets"],
              ["logs", "Diagnostic log"],
            ] as [Tab, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`-mb-px border-b-2 px-4 py-2 text-[14px] font-medium ${tab === k ? "border-brand text-brand" : "border-transparent text-ink-3 hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="mt-4">
            {tab === "approvals" && <Approvals rows={approvals} client={client} reload={load} openSession={setSessionView} />}
            {tab === "tickets" && <Tickets rows={tickets} client={client} reload={load} openSession={setSessionView} />}
            {tab === "logs" && <Logs rows={logs} openSession={setSessionView} />}
          </div>
        </div>
      </main>

      {sessionView && <SessionDrawer id={sessionView} client={client} onClose={() => setSessionView(null)} />}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value?: number; accent?: boolean }) {
  return (
    <div className={`rounded-xl border bg-white px-4 py-3 ${accent ? "border-amber-300 ring-4 ring-amber-100" : "border-line"}`}>
      <p className="text-2xl font-semibold tabular-nums">{value ?? "—"}</p>
      <p className="text-[12.5px] text-ink-2">{label}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-line bg-white py-12 text-center text-[14px] text-ink-3">{text}</p>;
}

type Client = ReturnType<typeof adminApi>;

/* ------------------------------------------------------------------ approvals */
function Approvals({ rows, client, reload, openSession }: { rows: AdminApproval[]; client: Client; reload: () => void; openSession: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");

  const decide = async (id: string, approve: boolean) => {
    setBusy(id + approve);
    setErr("");
    try {
      await client.decide(id, approve, notes[id] || "");
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!rows.length) return <Empty text="No change requests yet. Level 2 requests from the agent appear here." />;
  const sorted = [...rows].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));

  return (
    <div className="space-y-3">
      {err && <p className="rounded-lg bg-rose-50 px-4 py-2 text-[13px] text-rose-700">{err}</p>}
      {sorted.map((a) => (
        <div key={a.id} className={`rounded-xl border bg-white p-4 ${a.status === "pending" ? "border-amber-300" : "border-line"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-semibold">{a.id}</span>
            <StatusPill status={a.status} />
            <LevelBadge level={2} />
            <span className="ml-auto text-[12px] text-ink-3">{timeAgo(a.created_at)}</span>
          </div>
          <p className="mt-2 text-[15px] font-medium">{a.label}</p>
          <p className="text-[12.5px] text-ink-3">Impact: {a.impact}</p>
          <div className="mt-2 rounded-lg bg-canvas px-3 py-2 text-[13.5px] text-ink-2">
            <span className="font-medium text-ink">Agent&apos;s evidence: </span>{a.reason || "—"}
          </div>
          <button onClick={() => openSession(a.session_id)} className="mt-2 text-[13px] text-brand-2 hover:underline">View conversation →</button>

          {a.status === "pending" ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                placeholder="Note to user (optional)"
                value={notes[a.id] || ""}
                onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-[13.5px] outline-none focus:border-brand-2"
              />
              <button disabled={!!busy} onClick={() => decide(a.id, false)} className="rounded-lg border border-rose-300 px-4 py-2 text-[13.5px] font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                Deny
              </button>
              <button disabled={!!busy} onClick={() => decide(a.id, true)} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-[13.5px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                {busy === a.id + "true" && <Spinner />} Approve
              </button>
            </div>
          ) : (
            <p className="mt-3 text-[12.5px] text-ink-3">
              Decided {a.decided_at ? timeAgo(a.decided_at) : ""}{a.admin_note ? ` · “${a.admin_note}”` : ""}
              {a.status === "dry_run" && " · user guided to run it manually"}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ tickets */
function Tickets({ rows, client, reload, openSession }: { rows: AdminTicket[]; client: Client; reload: () => void; openSession: (id: string) => void }) {
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const shown = rows.filter((t) => filter === "all" || t.status === filter);

  const setStatus = async (id: string, status: string) => {
    await client.setTicket(id, status);
    reload();
  };

  return (
    <div>
      <div className="mb-3 flex gap-2">
        {["all", "escalated", "resolved", "closed"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 text-[13px] capitalize ring-1 ${filter === f ? "bg-brand text-white ring-brand" : "bg-white text-ink-2 ring-line hover:ring-slate-300"}`}>
            {f}
          </button>
        ))}
      </div>
      {!shown.length ? (
        <Empty text="No tickets." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          {shown.map((t) => (
            <div key={t.id} className="border-b border-line last:border-0">
              <button onClick={() => setOpen(open === t.id ? null : t.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-canvas">
                <span className="font-mono text-[13px] font-semibold">{t.id}</span>
                <StatusPill status={t.status} />
                <StatusPill status={t.priority} />
                <span className="text-[12.5px] capitalize text-ink-2">{t.category.replace(/_/g, " ")}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-2">{t.summary}</span>
                <span className="text-[12px] text-ink-3">{timeAgo(t.created_at)}</span>
              </button>
              {open === t.id && (
                <div className="grid gap-3 bg-canvas/60 px-4 py-4 text-[13.5px] md:grid-cols-2">
                  <Field k="Summary" v={t.summary} wide />
                  <Field k="Location" v={t.location} />
                  <Field k="Connection" v={t.connection_type} />
                  <Field k="Steps tried" v={t.steps_tried} wide />
                  <Field k="Suspected cause" v={t.suspected_cause} wide />
                  <div className="flex flex-wrap gap-2 md:col-span-2">
                    {t.session_id && <button onClick={() => openSession(t.session_id!)} className="rounded-lg bg-white px-3 py-1.5 text-[13px] text-brand-2 ring-1 ring-line">View conversation</button>}
                    {t.status !== "closed" && <button onClick={() => setStatus(t.id, "closed")} className="rounded-lg bg-brand px-3 py-1.5 text-[13px] text-white">Mark closed</button>}
                    {t.status === "closed" && <button onClick={() => setStatus(t.id, "escalated")} className="rounded-lg bg-white px-3 py-1.5 text-[13px] ring-1 ring-line">Reopen</button>}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{k}</p>
      <p className="whitespace-pre-wrap">{v || "—"}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ logs */
function Logs({ rows, openSession }: { rows: AdminLog[]; openSession: (id: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!rows.length) return <Empty text="No diagnostics have run yet." />;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="w-full text-[13px]">
        <thead className="bg-canvas text-left text-[11px] uppercase tracking-wider text-ink-3">
          <tr>
            <th className="px-4 py-2">Time</th><th className="px-4 py-2">Tool</th><th className="px-4 py-2">Level</th>
            <th className="px-4 py-2">Status</th><th className="px-4 py-2">Duration</th><th className="px-4 py-2">By</th><th className="px-4 py-2">Session</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <Fragment key={l.id}>
              <tr onClick={() => setOpen(open === l.id ? null : l.id)} className="cursor-pointer border-t border-line hover:bg-canvas">
                <td className="whitespace-nowrap px-4 py-2 text-ink-3">{timeAgo(l.created_at)}</td>
                <td className="px-4 py-2 font-medium">{toolLabel(l.tool)}</td>
                <td className="px-4 py-2"><LevelBadge level={l.level} /></td>
                <td className="px-4 py-2"><StatusPill status={l.status} /></td>
                <td className="px-4 py-2 tabular-nums text-ink-2">{l.duration_ms} ms</td>
                <td className="px-4 py-2 capitalize text-ink-2">{l.actor}</td>
                <td className="px-4 py-2">
                  {l.session_id && (
                    <button onClick={(e) => { e.stopPropagation(); openSession(l.session_id!); }} className="font-mono text-[12px] text-brand-2 hover:underline">
                      {l.session_id.slice(0, 8)}
                    </button>
                  )}
                </td>
              </tr>
              {open === l.id && (
                <tr className="bg-canvas/60">
                  <td colSpan={7} className="px-4 py-3">
                    <pre className="max-h-72 overflow-auto rounded-lg bg-ink p-3 font-mono text-[12px] text-slate-100">
                      {JSON.stringify({ arguments: l.arguments, result: l.result }, null, 2)}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ session drawer */
function SessionDrawer({ id, client, onClose }: { id: string; client: Client; onClose: () => void }) {
  const [data, setData] = useState<{ title: string; items: Array<Record<string, unknown>> } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    client.session(id).then(setData).catch((e) => setErr((e as Error).message));
  }, [id, client]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{data?.title || "Conversation"}</p>
            <p className="font-mono text-[11.5px] text-ink-3">{id}</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-ink-3 hover:bg-canvas hover:text-ink" aria-label="Close">✕</button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto bg-canvas px-5 py-4">
          {err && <p className="text-rose-700">{err}</p>}
          {!data && !err && <Spinner className="mx-auto h-6 w-6 text-ink-3" />}
          {data?.items.map((it, i) => {
            if (it.kind === "user")
              return <div key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-xl bg-brand-2 px-3 py-2 text-[13.5px] text-white">{String(it.text)}</div>;
            if (it.kind === "assistant")
              return <div key={i} className="max-w-[90%] rounded-xl border border-line bg-white px-3 py-2"><Markdown text={String(it.text)} /></div>;
            if (it.kind === "notice")
              return <p key={i} className="rounded-lg bg-sky-50 px-3 py-2 text-[12.5px] text-sky-900">{String(it.text)}</p>;
            return (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-[12.5px] ring-1 ring-line">
                <StatusPill status={String(it.status)} />
                <span className="font-medium">{toolLabel(String(it.tool))}</span>
                <span className="truncate font-mono text-ink-2">{String(it.summary || "")}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
