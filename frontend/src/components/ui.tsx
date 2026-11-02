"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Logo({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#ffffff" fillOpacity=".1" />
      <path d="M8 13a11 11 0 0 1 16 0M11 16.5a6.5 6.5 0 0 1 10 0" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <circle cx="16" cy="21" r="2.2" fill="#38bdf8" />
    </svg>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat text-[14.5px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

const LEVEL_STYLE: Record<number, string> = {
  1: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  2: "bg-amber-50 text-amber-700 ring-amber-200",
  3: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function LevelBadge({ level }: { level: number }) {
  const text = level === 1 ? "L1 · Read-only" : level === 2 ? "L2 · Needs approval" : "L3 · Blocked";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${LEVEL_STYLE[level] || LEVEL_STYLE[3]}`}>
      {text}
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 ring-amber-200",
  pending_approval: "bg-amber-50 text-amber-700 ring-amber-200",
  escalated: "bg-orange-50 text-orange-700 ring-orange-200",
  resolved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  executed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  dry_run: "bg-sky-50 text-sky-700 ring-sky-200",
  closed: "bg-slate-100 text-slate-600 ring-slate-200",
  denied: "bg-rose-50 text-rose-700 ring-rose-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  timeout: "bg-rose-50 text-rose-700 ring-rose-200",
  blocked: "bg-rose-50 text-rose-700 ring-rose-200",
  high: "bg-rose-50 text-rose-700 ring-rose-200",
  medium: "bg-amber-50 text-amber-700 ring-amber-200",
  low: "bg-slate-100 text-slate-600 ring-slate-200",
};

const STATUS_TEXT: Record<string, string> = {
  dry_run: "approved · manual",
  pending_approval: "pending",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1 ring-inset ${STATUS_STYLE[status] || "bg-slate-100 text-slate-600 ring-slate-200"}`}>
      {STATUS_TEXT[status] || status.replace(/_/g, " ")}
    </span>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
