"use client";

import dynamic from "next/dynamic";
import { useMemo, useSyncExternalStore } from "react";
import type { Agent, Escalation, PolicyRule, Trace } from "@/types/db";
import type { CooData } from "@/lib/cooData";
import type { MapInput } from "./layout";
import { GraphLegend } from "./GraphLegend";
import { useActiveTab } from "@/components/dashboard/tabContext";

// three.js is large and only the Today tab needs it, so it is split out and
// never rendered on the server (there is no WebGL there).
const GraphCanvas = dynamic(() => import("./GraphCanvas").then((m) => m.GraphCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-white/40">Loading the map…</div>
  ),
});

const noSubscribe = () => () => {};

/** Whether this browser can draw the scene at all. False on the server, so the
 *  first paint is the fallback and the client then upgrades, with no mismatch. */
function useWebGL(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => {
      try {
        const c = document.createElement("canvas");
        return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
      } catch {
        return false;
      }
    },
    () => false
  );
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  );
}

/**
 * The live map of the business: your agents inside the Payment Wall, your stock
 * on one side, your suppliers on the other, your wallet underneath, and your
 * guardrails above, with every proposed action drawn as a line that has to cross
 * the wall.
 */
export function OperationsMap({
  coo,
  agents,
  rules,
  traces,
  escalations,
}: {
  coo: CooData;
  agents: Agent[];
  rules: PolicyRule[];
  traces: Trace[];
  escalations: Escalation[];
}) {
  const webgl = useWebGL();
  const active = useActiveTab() === "today";
  const reduced = useReducedMotion();

  const data = useMemo<MapInput>(
    () => ({
      agents,
      rules,
      traces,
      walletPaise: coo.kpis.walletPaise,
      products: coo.insights
        .filter((i) => i.active)
        .map((i) => ({
          id: i.productId,
          sku: i.sku,
          name: i.name,
          status: i.status,
          stockQty: i.stockQty,
          stockValuePaise: i.cashTiedPaise ?? 0,
          pricePaise: i.pricePaise,
          compareAtPaise: i.compareAtPaise,
          runwayDays: i.runwayDays,
          needsRestock: i.needsRestock,
          units30d: i.units30d,
        })),
      vendors: coo.vendors.map((v) => ({ id: v.id, name: v.name, status: v.status, simulated: v.simulated })),
      payees: coo.payees.map((p) => ({ id: p.id, vendorId: p.vendor_id, status: p.status, label: p.display_name })),
      purchaseOrders: coo.purchaseOrders.map((p) => ({ id: p.id, vendorId: p.vendor_id, status: p.status, totalPaise: Number(p.total_paise) })),
    }),
    [coo, agents, rules, traces]
  );

  return (
    <div className="relative h-[560px] overflow-hidden rounded-2xl panel-card-lg">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24" style={{ background: "linear-gradient(to bottom, rgba(5,6,10,0.65), transparent)" }} />
      <div className="pointer-events-none absolute left-5 top-4 z-10">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-white/70">Live map</p>
        <p className="mt-0.5 text-xs text-white/50">your agents, your stock and your suppliers, with the wall between them</p>
      </div>

      {webgl && !reduced ? (
        <GraphCanvas data={data} escalations={escalations} active={active} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <p className="text-sm font-medium text-white/80">{reduced ? "Animations are turned down" : "This browser can't draw the 3D map"}</p>
          <p className="max-w-md text-xs text-white/45">
            The map shows your agents inside the Payment Wall, with stock, suppliers and cash around it. Everything it shows is also in the tabs above.
          </p>
        </div>
      )}
      {webgl && !reduced && <GraphLegend />}
    </div>
  );
}
