"use client";

import { useRef, useState } from "react";
import { createDomain, deleteDomain, moveDomain, updateDomainRouting } from "@/lib/actions/domains";
import { submitManualPolicyDraft } from "@/lib/actions/horizon";
import { resolveDomain } from "@/lib/policy/domains";
import type { Agent, Escalation, PolicyDomain, PolicyRule, Trace } from "@/types/db";
import { DangerButton, EmptyState, GhostButton, PrimaryButton, actionTypeLabel } from "./ui";

const KNOWN_ACTION_TYPES = ["order.create", "refund.create", "subscription.create"];

const TYPE_LABEL: Record<PolicyRule["type"], string> = {
  cap: "Cap",
  velocity: "Velocity",
  category_block: "Category block",
  trust_floor: "Trust floor",
  step_up: "Step-up",
};

interface DomainFormValue {
  name: string;
  description: string;
  matchActionTypes: string[];
  matchCategories: string;
}

const EMPTY_FORM: DomainFormValue = { name: "", description: "", matchActionTypes: [], matchCategories: "" };

/**
 * The visual piece of the policy-domains architecture: every domain is a
 * real row (src/lib/actions/domains.ts), positioned and dragged here —
 * arrangement only, persisted on drop, not a wiring diagram of live
 * execution routing (that's still content-based matching under the hood,
 * computed in src/lib/policy/domains.ts, not literal drawn connections).
 * Creating a domain here is a real merchant action: name it, tell it which
 * action types or categories belong to it, and it immediately starts
 * governing matching traffic with its own (initially empty) rule set.
 */
export function PolicyDomainsCanvas({
  domains,
  rules,
  escalations,
  agents,
  traces,
}: {
  domains: PolicyDomain[];
  rules: PolicyRule[];
  escalations: Escalation[];
  agents: Agent[];
  traces: Trace[];
}) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const tracesById = new Map(traces.map((t) => [t.id, t]));

  // Prefers the domain snapshotted on the trace at decision time
  // (trace.domain_id — see supabase/migrations/0005_traces_domain_snapshot.sql)
  // over recomputing it from today's routing, so a domain's stats reflect
  // what actually governed each transaction historically, not what would
  // govern it if it happened again right now. Only falls back to
  // resolveDomain for a trace that predates the column and slipped past the
  // migration's backfill.
  function domainIdForTrace(t: Trace): string | null {
    if (t.domain_id) return t.domain_id;
    const p = t.params as { category?: string } | null;
    return resolveDomain(t.action_type, p?.category, domains)?.id ?? null;
  }

  function statsFor(domain: PolicyDomain) {
    const domainRules = rules.filter((r) => r.domain_id === domain.id && r.status === "active");
    const domainTraceIds = new Set(traces.filter((t) => domainIdForTrace(t) === domain.id).map((t) => t.id));
    const pendingEscalations = escalations.filter((e) => e.status === "pending" && domainTraceIds.has(e.trace_id)).length;
    const agentIds = new Set(
      [...domainTraceIds].map((id) => tracesById.get(id)?.agent_id).filter((id): id is string => Boolean(id))
    );
    const agentNames = [...agentIds].map((id) => agentById.get(id)?.name ?? "Unknown agent");
    return { domainRules, pendingEscalations, agentNames, traceCount: domainTraceIds.size };
  }

  async function handleCreate(value: DomainFormValue) {
    setError(null);
    setPending(true);
    try {
      await createDomain({
        name: value.name,
        description: value.description,
        matchActionTypes: value.matchActionTypes,
        matchCategories: value.matchCategories.split(",").map((c) => c.trim()).filter(Boolean),
      });
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the domain.");
    } finally {
      setPending(false);
    }
  }

  async function handleUpdate(domainId: string, value: DomainFormValue) {
    setError(null);
    setPending(true);
    try {
      await updateDomainRouting(domainId, {
        name: value.name,
        description: value.description,
        matchActionTypes: value.matchActionTypes,
        matchCategories: value.matchCategories.split(",").map((c) => c.trim()).filter(Boolean),
      });
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the domain.");
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(domainId: string, name: string) {
    if (!window.confirm(`Delete domain "${name}"? Only possible if it has no rules attached.`)) return;
    setError(null);
    try {
      await deleteDomain(domainId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the domain.");
    }
  }

  return (
    <div className="panel-card rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Policy domains</p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
            Each domain is independently governed — its own rules, its own approval queue, its own agents. Drag
            to arrange; routing itself is by action type or category, not the position on this canvas.
          </p>
        </div>
        <PrimaryButton onClick={() => setCreating(true)} className="shrink-0 px-4">
          + Add domain
        </PrimaryButton>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {creating && (
        <div className="mb-4">
          <DomainForm
            initial={EMPTY_FORM}
            pending={pending}
            submitLabel="Create domain"
            onCancel={() => setCreating(false)}
            onSubmit={handleCreate}
          />
        </div>
      )}

      <DomainCanvasArea domains={domains}>
        {domains.map((domain) => {
          const stats = statsFor(domain);
          const isEditing = editingId === domain.id;
          return (
            <DomainCard key={domain.id} domain={domain} onMoved={(x, y) => moveDomain(domain.id, x, y)}>
              {isEditing ? (
                <DomainForm
                  initial={{
                    name: domain.name,
                    description: domain.description ?? "",
                    matchActionTypes: domain.match_action_types,
                    matchCategories: domain.match_categories.join(", "),
                  }}
                  pending={pending}
                  submitLabel="Save"
                  onCancel={() => setEditingId(null)}
                  onSubmit={(v) => handleUpdate(domain.id, v)}
                />
              ) : (
                <>
                  {domain.description && (
                    <p className="mt-1 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                      {domain.description}
                    </p>
                  )}
                  <p className="mt-2 text-[10px]" style={{ color: "var(--muted-2)" }}>
                    {domain.is_default ? (
                      "Catch-all default — anything no other domain claims"
                    ) : (
                      <>
                        <span style={{ color: "var(--muted)" }}>Routes here on: </span>
                        {[
                          ...domain.match_action_types.map((t) => actionTypeLabel(t)),
                          ...domain.match_categories.map((c) => `category "${c}"`),
                        ].join(" · ") || "nothing yet — click Edit routing"}
                      </>
                    )}
                  </p>

                  <div className="mt-3 flex items-center gap-3 text-[11px]" style={{ color: "var(--muted)" }}>
                    <span>{stats.domainRules.length} rule{stats.domainRules.length === 1 ? "" : "s"}</span>
                    <span title={stats.agentNames.join(", ")}>
                      {stats.agentNames.length} agent{stats.agentNames.length === 1 ? "" : "s"}
                    </span>
                    {stats.pendingEscalations > 0 && (
                      <span style={{ color: "var(--decision-escalate)" }}>{stats.pendingEscalations} pending</span>
                    )}
                  </div>

                  {stats.domainRules.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {stats.domainRules.slice(0, 4).map((r) => (
                        <li key={r.id} className="truncate text-[10px]" style={{ color: "var(--muted-2)" }}>
                          {TYPE_LABEL[r.type]} — {r.name}
                        </li>
                      ))}
                    </ul>
                  )}

                  <DomainQuickDraft domainId={domain.id} />

                  <div className="mt-3 flex gap-2">
                    <GhostButton onClick={() => setEditingId(domain.id)} className="flex-1 py-1! px-2! text-[10px]!">
                      Edit routing
                    </GhostButton>
                    {!domain.is_default && (
                      <DangerButton onClick={() => handleDelete(domain.id, domain.name)} className="py-1! px-2! text-[10px]!">
                        Delete
                      </DangerButton>
                    )}
                  </div>
                </>
              )}
            </DomainCard>
          );
        })}
      </DomainCanvasArea>

      {domains.length === 0 && <EmptyState text="No domains yet — click Run demo, it seeds Purchases and Recurring Mandates." />}
    </div>
  );
}

function DomainCanvasArea({ domains, children }: { domains: PolicyDomain[]; children: React.ReactNode }) {
  const maxY = Math.max(360, ...domains.map((d) => d.position_y + 260));
  return (
    <div
      className="relative w-full overflow-auto rounded-xl border"
      style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", height: Math.min(maxY, 640) }}
    >
      <div className="relative" style={{ height: maxY, minWidth: "100%" }}>
        {children}
      </div>
    </div>
  );
}

function DomainCard({
  domain,
  onMoved,
  children,
}: {
  domain: PolicyDomain;
  onMoved: (x: number, y: number) => void;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState({ x: domain.position_x, y: domain.position_y });
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; origX: number; origY: number }>({
    dragging: false,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });

  function onPointerDown(e: React.PointerEvent) {
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPos({ x: Math.max(0, dragRef.current.origX + dx), y: Math.max(0, dragRef.current.origY + dy) });
  }
  function onPointerUp() {
    if (!dragRef.current.dragging) return;
    dragRef.current.dragging = false;
    onMoved(pos.x, pos.y);
  }

  return (
    <div
      className="absolute w-64 rounded-xl border p-3.5 shadow-lg"
      style={{ left: pos.x, top: pos.y, borderColor: "var(--panel-border-strong)", background: "var(--panel)" }}
    >
      <div
        className="mb-1 flex cursor-grab items-center justify-between gap-2 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="flex items-center gap-2 truncate text-sm font-semibold">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: domain.color, boxShadow: `0 0 6px ${domain.color}` }} />
          {domain.name}
        </span>
        <span className="shrink-0 text-[10px]" style={{ color: "var(--muted-2)" }}>
          drag
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * The "hard to fill" gap this closes: before this, the only way a rule
 * landed in a specific domain was drafting it via the Policies tab's
 * Horizon panel (which always defaults to the catch-all domain) and then
 * separately reassigning it. This drafts straight into THIS domain in one
 * step — same real draft_policy pipeline (LLM -> structured rule ->
 * backtest -> pending_review), just pre-targeted, via the same
 * `submitManualPolicyDraft` action the Horizon panel uses, now with an
 * optional target domain.
 */
function DomainQuickDraft({ domainId }: { domainId: string }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setStatus("working");
    setMessage(null);
    try {
      const result = await submitManualPolicyDraft(text, domainId);
      setStatus("done");
      setMessage(`Drafted "${result.name}" — approve it in the Policies tab.`);
      setText("");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Draft failed.");
    }
  }

  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
        Draft a rule for this domain
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='e.g. "Block anything over ₹10,000 outright"'
        rows={2}
        className="w-full resize-none rounded-lg border px-2 py-1.5 text-[11px]"
        style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel-2)", color: "var(--foreground)" }}
      />
      <GhostButton
        onClick={submit}
        disabled={status === "working" || !text.trim()}
        className="mt-1.5 w-full py-1! px-2! text-[10px]!"
      >
        {status === "working" ? "Drafting…" : "Draft into this domain"}
      </GhostButton>
      {message && (
        <p className="mt-1.5 text-[10px]" style={{ color: status === "error" ? "var(--decision-block)" : "var(--decision-allow)" }}>
          {message}
        </p>
      )}
    </div>
  );
}

function DomainForm({
  initial,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: DomainFormValue;
  pending: boolean;
  submitLabel: string;
  onSubmit: (value: DomainFormValue) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
      className="rounded-xl border p-3.5 space-y-2.5"
      style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel-2)" }}
    >
      <input
        required
        placeholder="Domain name (e.g. Logistics)"
        value={value.name}
        onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
        className="w-full rounded-lg border px-2.5 py-1.5 text-xs"
        style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel)", color: "var(--foreground)" }}
      />
      <textarea
        placeholder="What this domain covers (optional)"
        value={value.description}
        onChange={(e) => setValue((v) => ({ ...v, description: e.target.value }))}
        rows={2}
        className="w-full resize-none rounded-lg border px-2.5 py-1.5 text-xs"
        style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel)", color: "var(--foreground)" }}
      />
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
          Routes here when action type is
        </p>
        <div className="flex flex-wrap gap-2">
          {KNOWN_ACTION_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                checked={value.matchActionTypes.includes(t)}
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    matchActionTypes: e.target.checked ? [...v.matchActionTypes, t] : v.matchActionTypes.filter((x) => x !== t),
                  }))
                }
              />
              {actionTypeLabel(t)}
            </label>
          ))}
        </div>
      </div>
      <input
        placeholder="…or category is one of: logistics, ads, vendor (comma-separated)"
        value={value.matchCategories}
        onChange={(e) => setValue((v) => ({ ...v, matchCategories: e.target.value }))}
        className="w-full rounded-lg border px-2.5 py-1.5 text-xs"
        style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel)", color: "var(--foreground)" }}
      />
      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={pending} className="flex-1">
          {pending ? "Working…" : submitLabel}
        </PrimaryButton>
        <GhostButton type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </GhostButton>
      </div>
    </form>
  );
}
