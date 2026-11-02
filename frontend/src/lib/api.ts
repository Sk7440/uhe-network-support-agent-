export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8001").replace(/\/$/, "");

/* ---------- Types ---------- */
export type ApprovalInfo = { id: string; action: string; label: string; status: string };
export type TicketInfo = { id: string; status: string; priority: string; category: string };

export type ToolItem = {
  kind: "tool";
  key: string;
  tool: string;
  level: number;
  status: string; // running | success | error | timeout | blocked | pending_approval
  summary?: string;
  duration_ms?: number;
  approval?: ApprovalInfo;
  ticket?: TicketInfo;
};

export type ChatItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; streaming?: boolean }
  | { kind: "notice"; key: string; text: string; tone?: "warn" | "error" | "info" }
  | ToolItem;

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_start"; id: string; tool: string; level: number }
  | ({ type: "tool_end"; id: string } & Omit<ToolItem, "kind" | "key">)
  | { type: "redacted"; message: string }
  | { type: "retract" }
  | { type: "error"; message: string }
  | { type: "done" };

export type Health = {
  api: boolean;
  ollama: boolean;
  model: string;
  model_available: boolean;
  kb_sections: number;
  level2_execution: boolean;
  diagnostics_mode: "local" | "demo";
  scenarios: Scenario[];
};

export type Scenario = { id: string; label: string; description: string; opening: string };

/* ---------- Helpers ---------- */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const d = await res.json();
      if (d?.detail) msg = typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch(`${API_URL}/api/health`, { cache: "no-store" }).then((r) => json<Health>(r)),
  createSession: (scenario?: string) =>
    fetch(`${API_URL}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: scenario ?? null }),
    }).then((r) => json<{ id: string }>(r)),
  getSession: (id: string) =>
    fetch(`${API_URL}/api/sessions/${id}`, { cache: "no-store" }).then((r) =>
      json<{ id: string; title: string; scenario: string | null; items: Array<Record<string, unknown>> }>(r),
    ),
  approval: (id: string) =>
    fetch(`${API_URL}/api/approvals/${id}`, { cache: "no-store" }).then((r) =>
      json<{ id: string; action: string; status: string; admin_note: string }>(r),
    ),
};

/** POSTs and reads a Server-Sent Events stream, calling onEvent for each event. */
export async function streamAgent(
  path: string,
  body: unknown,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    await json(res); // throws with server message
    throw new Error("No response stream");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  }
}

/* ---------- Admin ---------- */
export function adminApi(token: string) {
  const h = { "X-Admin-Token": token, "Content-Type": "application/json" };
  const get = <T,>(p: string) => fetch(`${API_URL}${p}`, { headers: h, cache: "no-store" }).then((r) => json<T>(r));
  return {
    stats: () => get<AdminStats>("/api/admin/stats"),
    approvals: () => get<AdminApproval[]>("/api/admin/approvals"),
    tickets: () => get<AdminTicket[]>("/api/admin/tickets"),
    logs: () => get<AdminLog[]>("/api/admin/logs?limit=300"),
    session: (id: string) => get<{ id: string; title: string; items: Array<Record<string, unknown>> }>(`/api/admin/sessions/${id}`),
    decide: (id: string, approve: boolean, note: string) =>
      fetch(`${API_URL}/api/admin/approvals/${id}/decision`, { method: "POST", headers: h, body: JSON.stringify({ approve, note }) }).then(
        (r) => json<{ id: string; status: string }>(r),
      ),
    setTicket: (id: string, status: string) =>
      fetch(`${API_URL}/api/admin/tickets/${id}`, { method: "PATCH", headers: h, body: JSON.stringify({ status }) }).then((r) =>
        json<{ id: string; status: string }>(r),
      ),
  };
}

export type AdminStats = {
  sessions: number;
  pending_approvals: number;
  tickets_escalated: number;
  tickets_resolved: number;
  diagnostics_run: number;
  tool_failures: number;
};
export type AdminApproval = {
  id: string; session_id: string; action: string; label: string; impact: string; reason: string;
  status: string; admin_note: string; result: Record<string, unknown>; created_at: string; decided_at: string | null;
};
export type AdminTicket = {
  id: string; session_id: string | null; status: string; category: string; priority: string; summary: string;
  location: string; connection_type: string; steps_tried: string; suspected_cause: string; created_at: string; updated_at: string;
};
export type AdminLog = {
  id: number; session_id: string | null; tool: string; level: number; arguments: Record<string, unknown>;
  status: string; result: Record<string, unknown>; duration_ms: number; actor: string; created_at: string;
};

/* ---------- Display helpers ---------- */
export const TOOL_LABELS: Record<string, string> = {
  check_ip_config: "Checked IP configuration",
  ping_gateway: "Pinged local gateway",
  check_internet: "Tested internet reachability",
  check_dns: "Tested DNS resolution",
  search_knowledge_base: "Searched UHE documentation",
  request_change: "Requested admin approval",
  create_ticket: "Registered helpdesk ticket",
};

export function toolLabel(name: string) {
  return TOOL_LABELS[name] || name.replace(/_/g, " ");
}

export function timeAgo(iso: string) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
