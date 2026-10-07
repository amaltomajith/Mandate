"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Billboard, Grid, Html, OrbitControls, Stars } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import type * as THREE from "three";
import { AdditiveBlending, Vector3 } from "three";
import type { Agent, Escalation, PolicyRule, Trace } from "@/types/db";
import { WALL_RADIUS, actionTarget, computeLayout, wallCrossing, type MapInput, type MapPayee, type MapPo, type MapProduct, type MapVendor, type Vec3 } from "./layout";
import { AgentBlob } from "./AgentBlobMaterial";
import { PulseEdges, type PulseEdge } from "./PulseEdges";
import { GlowShellMaterial } from "./GlowShell";
import { WallShield, type Flare } from "./WallShield";
import { ENTITY_COLORS, PAYEE_COLORS, PO_COLORS, STOCK_COLORS, VENDOR_COLORS, traceColor, tracePresence } from "./colors";
import { actionTypeLabel, formatMoney } from "@/lib/format";

/**
 * Frames the whole cluster on first load, once. Re-framing while someone is
 * orbiting would yank the view out from under them, and the point of the scene
 * is that it can be inspected by hand.
 */
function FitToNodes({ positions }: { positions: Vec3[] }) {
  const { camera } = useThree();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current || positions.length === 0) return;
    fitted.current = true;
    let max = 0;
    for (const [x, y, z] of positions) max = Math.max(max, Math.hypot(x, y * 0.6, z));
    const distance = Math.max(14, max * 2.0 + 2.5);
    const direction = new Vector3(1, 0.62, 1).normalize();
    camera.position.copy(direction.multiplyScalar(distance));
    camera.lookAt(0, 0.5, 0);
    camera.updateProjectionMatrix();
  }, [positions, camera]);

  return null;
}

const RULE_TYPE_LABELS: Record<PolicyRule["type"], string> = {
  cap: "Spend cap",
  velocity: "Rate limit",
  category_block: "Category block",
  catalog_scope: "Catalog scope",
  trust_floor: "Trust floor",
  step_up: "Needs approval",
  whitelisted_payee: "Approved payees only",
  min_margin_floor: "Margin floor",
  payout_budget: "Payout budget",
};

const DECISION_LABELS: Record<Trace["decision"], string> = {
  allow: "Allowed",
  block: "Blocked",
  escalate: "Escalated",
  protocol_reject: "Rejected: invalid signature",
};

// An escalation's decision never changes (the trace records that a human WAS
// asked); whether anyone has since answered lives on the escalation row.
const ESCALATION_STATUS_SUFFIX: Record<Escalation["status"], string> = {
  pending: " — needs approval",
  approved: " — approved",
  denied: " — denied",
};

const STOCK_LABELS: Record<MapProduct["status"], string> = {
  healthy: "Healthy",
  low: "Running low",
  stockout: "Out of stock",
  overstock: "Overstocked",
  dead: "Not selling",
};

type HoverInfo =
  | { kind: "agent"; agent: Agent; position: Vec3 }
  | { kind: "rule"; rule: PolicyRule; position: Vec3 }
  | { kind: "trace"; trace: Trace; position: Vec3; escalationStatus?: Escalation["status"] }
  | { kind: "product"; product: MapProduct; position: Vec3 }
  | { kind: "vendor"; vendor: MapVendor; position: Vec3 }
  | { kind: "payee"; payee: MapPayee; vendorName: string; position: Vec3 }
  | { kind: "po"; po: MapPo; vendorName: string; position: Vec3 }
  | { kind: "wallet"; walletPaise: number; position: Vec3 }
  | { kind: "wall"; position: Vec3 }
  | null;

const MAX_VISIBLE_TRACES = 120;
const MAX_ACTION_EDGES_PER_AGENT = 12;

type HoverSetter = (h: HoverInfo) => void;

/** Props every hoverable node shares: show the card on enter, hide on leave. */
function hoverHandlers(info: NonNullable<HoverInfo>, set: HoverSetter) {
  return {
    onPointerOver: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      set(info);
    },
    onPointerOut: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      set(null);
    },
  };
}

function Label({ text, y = 0.95, color = "#a4acc4" }: { text: string; y?: number; color?: string }) {
  return (
    <Html position={[0, y, 0]} center style={{ pointerEvents: "none" }} zIndexRange={[10, 0]}>
      <span className="whitespace-nowrap text-[10.5px] font-medium tracking-wide" style={{ color, textShadow: "0 0 6px #05060a, 0 0 2px #05060a" }}>
        {text}
      </span>
    </Html>
  );
}

function AgentNode({ agent, position, onHover }: { agent: Agent; position: Vec3; onHover: HoverSetter }) {
  const baseScale = 0.32 + (agent.trust_score / 100) * 0.34;
  return (
    <group position={position} {...hoverHandlers({ kind: "agent", agent, position }, onHover)}>
      {/* The ring-and-core node, unchanged: its agitation and sweep speed are a
          reading of the agent's own trust score, not decoration. */}
      <AgentBlob color={ENTITY_COLORS.agent} scale={baseScale} trustScore={agent.trust_score} />
      <Label text={agent.kind === "selling" ? "Selling agent" : agent.kind === "buying" ? "Buying agent" : agent.name} y={0.78} color="#f3b6ee" />
    </group>
  );
}

function RuleNode({ rule, position, onHover }: { rule: PolicyRule; position: Vec3; onHover: HoverSetter }) {
  return (
    <group position={position} {...hoverHandlers({ kind: "rule", rule, position }, onHover)}>
      <mesh>
        <octahedronGeometry args={[0.22]} />
        <meshStandardMaterial color="#e8f2ff" emissive={ENTITY_COLORS.rule} emissiveIntensity={0.5} roughness={0.25} metalness={0.2} />
      </mesh>
      <mesh>
        <octahedronGeometry args={[0.4]} />
        <GlowShellMaterial color={ENTITY_COLORS.rule} power={2.2} strength={0.75} />
      </mesh>
    </group>
  );
}

function ProductNode({ product, position, maxValue, onHover }: { product: MapProduct; position: Vec3; maxValue: number; onHover: HoverSetter }) {
  const color = STOCK_COLORS[product.status];
  const height = 0.3 + 1.0 * Math.sqrt(maxValue > 0 ? product.stockValuePaise / maxValue : 0.2);
  const alarm = product.status === "low" || product.status === "stockout";
  const ringRef = useRef<THREE.Mesh>(null);
  const [startAt] = useState(() => Math.random() * 3);

  // Running low or out is the one thing on the shelf that wants a person, so it
  // alone pulses. Everything else sits still.
  useFrame(({ clock, camera }) => {
    const ring = ringRef.current;
    if (!ring) return;
    ring.quaternion.copy(camera.quaternion);
    const t = (clock.getElapsedTime() + startAt) % 1.6;
    ring.scale.setScalar(1 + t * 0.7);
    (ring.material as THREE.MeshBasicMaterial).opacity = (1 - t / 1.6) * 0.7;
  });

  return (
    <group position={position} {...hoverHandlers({ kind: "product", product, position }, onHover)}>
      <mesh>
        <cylinderGeometry args={[0.3, 0.3, height, 6]} />
        <meshStandardMaterial color="#e8f2ff" emissive={color} emissiveIntensity={product.status === "dead" ? 0.28 : 0.6} roughness={0.3} metalness={0.15} />
      </mesh>
      <mesh scale={[1.5, 1 + 0.5 / Math.max(height, 0.4), 1.5]}>
        <cylinderGeometry args={[0.3, 0.3, height, 6]} />
        <GlowShellMaterial color={color} power={2.4} strength={product.status === "dead" ? 0.5 : 0.95} />
      </mesh>
      {product.compareAtPaise !== null && (
        <Billboard position={[0, height / 2 + 0.16, 0]}>
          <mesh>
            <ringGeometry args={[0.1, 0.14, 24]} />
            <meshBasicMaterial color="#3ddc84" transparent opacity={0.9} depthWrite={false} blending={AdditiveBlending} />
          </mesh>
        </Billboard>
      )}
      {alarm && (
        <mesh ref={ringRef} position={[0, 0, 0]}>
          <ringGeometry args={[0.46, 0.52, 40]} />
          <meshBasicMaterial color={color} transparent opacity={0.6} depthWrite={false} blending={AdditiveBlending} />
        </mesh>
      )}
      <Label text={product.name} y={height / 2 + 0.48} />
    </group>
  );
}

function VendorNode({ vendor, position, onHover }: { vendor: MapVendor; position: Vec3; onHover: HoverSetter }) {
  const color = VENDOR_COLORS[vendor.status];
  const dim = vendor.status === "candidate" ? 0.5 : 1;
  return (
    <group position={position} {...hoverHandlers({ kind: "vendor", vendor, position }, onHover)}>
      <mesh scale={0.22}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#e6f6ff" emissive={color} emissiveIntensity={0.85 * dim} roughness={0.25} metalness={0.2} />
      </mesh>
      <mesh scale={0.44}>
        <octahedronGeometry args={[1, 0]} />
        <GlowShellMaterial color={color} power={2.2} strength={1.05 * dim} />
      </mesh>
      <Billboard>
        <mesh>
          <ringGeometry args={[0.42, 0.47, 6]} />
          <meshBasicMaterial color={color} transparent opacity={0.8 * dim} depthWrite={false} blending={AdditiveBlending} />
        </mesh>
      </Billboard>
      <Label text={vendor.name} y={0.78} />
    </group>
  );
}

function PayeeNode({ payee, vendorName, position, onHover }: { payee: MapPayee; vendorName: string; position: Vec3; onHover: HoverSetter }) {
  const color = PAYEE_COLORS[payee.status];
  return (
    <group position={position} {...hoverHandlers({ kind: "payee", payee, vendorName, position }, onHover)}>
      <mesh scale={0.1}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshStandardMaterial color="#ffffff" emissive={color} emissiveIntensity={1} roughness={0.3} />
      </mesh>
      <mesh scale={0.2}>
        <sphereGeometry args={[1, 12, 12]} />
        <GlowShellMaterial color={color} power={2} strength={0.9} />
      </mesh>
    </group>
  );
}

function PoNode({ po, vendorName, position, onHover }: { po: MapPo; vendorName: string; position: Vec3; onHover: HoverSetter }) {
  const color = PO_COLORS[po.status];
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.5;
  });
  return (
    <group position={position} {...hoverHandlers({ kind: "po", po, vendorName, position }, onHover)}>
      <mesh ref={ref} scale={0.17}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#efe9ff" emissive={color} emissiveIntensity={0.8} roughness={0.3} />
      </mesh>
      <mesh scale={0.34}>
        <boxGeometry args={[1, 1, 1]} />
        <GlowShellMaterial color={color} power={2.2} strength={0.9} />
      </mesh>
    </group>
  );
}

function WalletNode({ walletPaise, position, onHover }: { walletPaise: number; position: Vec3; onHover: HoverSetter }) {
  // Radius grows with the log of the balance: a wallet of lakhs should look
  // bigger than one of thousands, but not a thousand times bigger.
  const radius = 0.42 + 0.34 * Math.min(1, Math.max(0, Math.log10(Math.max(walletPaise / 100, 1) / 1000) / 3));
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.scale.setScalar(1 + Math.sin(clock.getElapsedTime() * 1.1) * 0.035);
  });
  return (
    <group position={position} {...hoverHandlers({ kind: "wallet", walletPaise, position }, onHover)}>
      <group ref={ref}>
        <mesh scale={radius}>
          <sphereGeometry args={[1, 40, 40]} />
          <meshStandardMaterial color="#f2fff8" emissive={ENTITY_COLORS.wallet} emissiveIntensity={0.55} roughness={0.2} metalness={0.3} />
        </mesh>
        <mesh scale={radius * 1.7}>
          <sphereGeometry args={[1, 32, 32]} />
          <GlowShellMaterial color={ENTITY_COLORS.wallet} power={2.4} strength={1.0} />
        </mesh>
      </group>
      <Label text="Wallet" y={radius * 1.7 + 0.35} color="#bdf3d8" />
    </group>
  );
}

function TraceNode({ trace, position, escalationStatus, onHover }: { trace: Trace; position: Vec3; escalationStatus?: Escalation["status"]; onHover: HoverSetter }) {
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const shockwaveRef = useRef<THREE.Mesh>(null);
  // Captures an impure value exactly once at mount, the sanctioned way.
  const [mountedAt] = useState(() => Date.now());
  const isFresh = (mountedAt - new Date(trace.created_at).getTime()) / 1000 < 6;
  const decisionColor = traceColor(trace.decision, escalationStatus);
  const restOpacity = tracePresence(trace.decision, escalationStatus);
  const isSevere = trace.decision === "block" || trace.decision === "protocol_reject";
  // Each node reads its OWN start time off the shared scene clock on its first
  // frame, so a node mounted a minute in still plays its arrival animation.
  const localStartRef = useRef<number | null>(null);

  useFrame(({ clock, camera }) => {
    if (localStartRef.current === null) localStartRef.current = clock.getElapsedTime();
    const localElapsed = clock.getElapsedTime() - localStartRef.current;
    if (ringRef.current) ringRef.current.quaternion.copy(camera.quaternion);
    if (shockwaveRef.current) shockwaveRef.current.quaternion.copy(camera.quaternion);

    if (groupRef.current) {
      const growth = Math.min(localElapsed / 0.35, 1);
      groupRef.current.scale.setScalar(1 - Math.pow(1 - growth, 3));
    }
    if (ringRef.current) {
      const mat = ringRef.current.material as THREE.MeshBasicMaterial;
      if (!isFresh) {
        ringRef.current.scale.setScalar(1);
        mat.opacity = restOpacity;
      } else {
        // A new action announces itself at full strength, then settles to the
        // weight its verdict deserves.
        const t = Math.min(localElapsed / 2.2, 1);
        ringRef.current.scale.setScalar(1.9 - t * 0.9);
        mat.opacity = restOpacity + (1 - restOpacity) * (1 - t);
      }
    }
    if (shockwaveRef.current) {
      if (isFresh && isSevere) {
        const t = Math.min(localElapsed / 1.1, 1);
        shockwaveRef.current.scale.setScalar(1 + t * 5);
        (shockwaveRef.current.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.6;
        shockwaveRef.current.visible = t < 1;
      } else {
        shockwaveRef.current.visible = false;
      }
    }
  });

  return (
    <group ref={groupRef} position={position} {...hoverHandlers({ kind: "trace", trace, position, escalationStatus }, onHover)}>
      <mesh scale={0.13}>
        <sphereGeometry args={[1, 20, 20]} />
        <meshStandardMaterial color={ENTITY_COLORS.transaction} emissive={ENTITY_COLORS.transaction} emissiveIntensity={0.18} roughness={0.35} />
      </mesh>
      <mesh ref={ringRef}>
        <ringGeometry args={[0.2, 0.27, 48]} />
        <meshBasicMaterial color={decisionColor} transparent opacity={0.55} depthWrite={false} side={2} blending={AdditiveBlending} />
      </mesh>
      {isSevere && (
        <mesh ref={shockwaveRef} visible={false}>
          <ringGeometry args={[0.3, 0.34, 48]} />
          <meshBasicMaterial color={decisionColor} transparent opacity={0} depthWrite={false} blending={AdditiveBlending} />
        </mesh>
      )}
    </group>
  );
}

function HoverPanel({ info }: { info: HoverInfo }) {
  // Split so HoverCard's hooks are unconditional.
  if (!info) return null;
  return <HoverCard info={info} />;
}

function HoverCard({ info }: { info: NonNullable<HoverInfo> }) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Keeps the card inside the panel. Position is written straight to the element
  // from the frame loop, because it depends on the camera and must follow while
  // someone orbits with a node hovered.
  useFrame(({ camera, size }) => {
    const el = cardRef.current;
    if (!el) return;
    const projected = new Vector3(info.position[0], info.position[1], info.position[2]).project(camera);
    const nodeX = (projected.x * 0.5 + 0.5) * size.width;
    const nodeY = (-projected.y * 0.5 + 0.5) * size.height;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const MARGIN = 12;
    const GAP = 14;
    const fitsAbove = nodeY - h - GAP >= MARGIN;
    const offsetY = fitsAbove ? -(h + GAP) : GAP;
    const clampedLeft = Math.max(MARGIN, Math.min(nodeX - w / 2, size.width - w - MARGIN));
    el.style.transform = `translate(${clampedLeft - nodeX}px, ${offsetY}px)`;
  });

  let title = "";
  let badge: { text: string; color: string } | null = null;
  let lines: string[] = [];

  switch (info.kind) {
    case "agent":
      title = info.agent.name;
      badge = { text: info.agent.kind === "external" ? "Outside agent" : "Your agent", color: ENTITY_COLORS.agent };
      lines = [`Trust ${info.agent.trust_score.toFixed(0)}/100. A bigger, steadier glow is a cleaner record.`, info.agent.description ?? ""];
      break;
    case "rule":
      title = info.rule.name;
      badge = { text: RULE_TYPE_LABELS[info.rule.type], color: ENTITY_COLORS.rule };
      lines = [info.rule.rationale ?? "No extra detail recorded for this rule."];
      break;
    case "product": {
      const p = info.product;
      title = p.name;
      badge = { text: STOCK_LABELS[p.status], color: STOCK_COLORS[p.status] };
      lines = [
        `${p.stockQty} in stock, ${p.units30d} sold in 30 days${p.runwayDays !== null ? `, about ${Math.round(p.runwayDays)} days left` : ""}.`,
        `Price ${formatMoney(p.pricePaise, "INR")}${p.compareAtPaise !== null ? ` (was ${formatMoney(p.compareAtPaise, "INR")}, on clearance)` : ""}.`,
      ];
      if (p.needsRestock) lines.push("The buying agent will reorder this.");
      break;
    }
    case "vendor":
      title = info.vendor.name;
      badge = { text: info.vendor.status === "candidate" ? "Awaiting your approval" : info.vendor.status, color: VENDOR_COLORS[info.vendor.status] };
      lines = [info.vendor.simulated ? "A sandbox supplier: nothing sent to it is real." : "A supplier. Only approved ones are contacted or paid."];
      break;
    case "payee":
      title = `${info.payee.label} (${info.vendorName})`;
      badge = { text: info.payee.status === "active" ? "Approved payee" : info.payee.status === "pending" ? "Awaiting approval" : "Revoked", color: PAYEE_COLORS[info.payee.status] };
      lines = ["Where money to this supplier goes. A person approved it; the agents never see the account."];
      break;
    case "po":
      title = `Order from ${info.vendorName}`;
      badge = { text: info.po.status.replace("_", " "), color: PO_COLORS[info.po.status] };
      lines = [`Total ${formatMoney(info.po.totalPaise, "INR")}.`];
      break;
    case "wallet":
      title = "Wallet";
      badge = { text: formatMoney(info.walletPaise, "INR"), color: ENTITY_COLORS.wallet };
      lines = ["Sales in, supplier payouts out. The glow grows with the balance."];
      break;
    case "wall":
      title = "The Payment Wall";
      badge = { text: "Every money action crosses it", color: ENTITY_COLORS.wall };
      lines = ["It flares green when an action is allowed, amber when it is held for you, and red when it is refused. No agent, message or prompt can go around it."];
      break;
    case "trace": {
      const p = info.trace.params as { amount?: number; currency?: string } | null;
      title = actionTypeLabel(info.trace.action_type) + (p?.amount && p?.currency ? ` · ${formatMoney(p.amount, p.currency)}` : "");
      const suffix = info.trace.decision === "escalate" && info.escalationStatus ? ESCALATION_STATUS_SUFFIX[info.escalationStatus] : "";
      badge = { text: DECISION_LABELS[info.trace.decision] + suffix, color: traceColor(info.trace.decision, info.escalationStatus) };
      lines = [info.trace.reasoning ?? ""];
      break;
    }
  }

  return (
    // No `distanceFactor`: it scales the overlay by camera distance, which made
    // this tooltip near-illegible for any node not right at the lens.
    <Html position={info.position} style={{ pointerEvents: "none" }} zIndexRange={[100, 0]}>
      <div ref={cardRef} className="w-72 rounded-xl border px-3.5 py-3 shadow-2xl backdrop-blur-md" style={{ background: "rgba(8,8,12,0.97)", borderColor: "rgba(255,255,255,0.14)", color: "#f3f1fb" }}>
        <p className="mb-1.5 text-[13px] font-semibold leading-snug">{title}</p>
        {badge && (
          <span className="mb-1.5 inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ background: `${badge.color}26`, color: badge.color }}>
            {badge.text}
          </span>
        )}
        {lines.filter(Boolean).map((line, i) => (
          <p key={i} className="mt-1 text-[12px] leading-relaxed" style={{ color: "#a4acc4" }}>
            {line}
          </p>
        ))}
      </div>
    </Html>
  );
}

function Scene({ data, escalations }: { data: MapInput; escalations: Escalation[] }) {
  const [hover, setHover] = useState<HoverInfo>(null);
  const [mountedAt] = useState(() => Date.now());
  const visibleTraces = useMemo(() => data.traces.slice(0, MAX_VISIBLE_TRACES), [data.traces]);
  const escalationStatusByTrace = useMemo(() => new Map(escalations.map((e) => [e.trace_id, e.status])), [escalations]);
  const layout = useMemo(() => computeLayout({ ...data, traces: visibleTraces }), [data, visibleTraces]);
  const maxValue = useMemo(() => Math.max(1, ...data.products.map((p) => p.stockValuePaise)), [data.products]);
  const vendorName = useMemo(() => new Map(data.vendors.map((v) => [v.id, v.name])), [data.vendors]);
  const pendingCount = escalations.filter((e) => e.status === "pending").length;

  // Lines. The pulse runs toward each edge's `from` end, so `from` is where the
  // movement should ARRIVE: money out arrives at the supplier, money in at the
  // wallet, an action's verdict at the agent that made it.
  const pulseEdges = useMemo<PulseEdge[]>(() => {
    const edges: PulseEdge[] = [];

    // Each agent to what its recent actions were about, coloured by the wall's
    // verdict. These are the lines that pass through the wall.
    for (const { item: agent, position } of layout.agents) {
      const own = layout.traces.filter((t) => t.item.agent_id === agent.id).slice(-MAX_ACTION_EDGES_PER_AGENT);
      for (const t of own) {
        const target = actionTarget(t.item, layout);
        if (!target) continue;
        const status = escalationStatusByTrace.get(t.item.id);
        edges.push({ from: target, to: position, color: traceColor(t.item.decision, status), opacity: 0.1 + 0.3 * tracePresence(t.item.decision, status) });
      }
    }

    // A rule to the actions it fired on.
    for (const t of layout.traces) {
      if (!t.item.rule_fired_id) continue;
      const rulePos = layout.rulePositionById[t.item.rule_fired_id];
      if (!rulePos) continue;
      const status = escalationStatusByTrace.get(t.item.id);
      edges.push({ from: t.position, to: rulePos, color: traceColor(t.item.decision, status), opacity: 0.07 + 0.2 * tracePresence(t.item.decision, status) });
    }

    // Money in: selling products feed the wallet.
    for (const { item: p, position } of layout.products) {
      if (p.units30d > 0) edges.push({ from: layout.wallet, to: position, color: "#3ddc84", opacity: 0.1 + Math.min(0.25, p.units30d / 200) });
    }

    // Money out: the wallet to each order, and the order on to its supplier.
    for (const { item: po, position } of layout.purchaseOrders) {
      const v = layout.vendorPositionById[po.vendorId];
      if (!v) continue;
      edges.push({ from: position, to: layout.wallet, color: ENTITY_COLORS.purchaseOrder, opacity: 0.22 });
      edges.push({ from: v, to: position, color: ENTITY_COLORS.purchaseOrder, opacity: 0.3 });
    }
    return edges;
  }, [layout, escalationStatusByTrace]);

  // A wall flare for every recent action, at the point it crossed. Actions that
  // never reached an agent (forged requests) flare at a fixed spot per request,
  // because they hit the wall from outside.
  const flares = useMemo<Flare[]>(() => {
    const out: Flare[] = [];
    for (const t of layout.traces) {
      if (new Date(t.item.created_at).getTime() < mountedAt - 90_000) continue;
      const status = escalationStatusByTrace.get(t.item.id);
      const color = traceColor(t.item.decision, status);
      const agentPos = t.item.agent_id ? layout.agentPositionById[t.item.agent_id] : null;
      const target = actionTarget(t.item, layout);
      const crossing = agentPos && target ? wallCrossing(agentPos, target) : null;
      if (crossing) out.push({ id: t.item.id, angle: crossing.angle, y: crossing.y, color });
      else {
        const h = parseInt(t.item.id.replace(/-/g, "").slice(0, 6), 16) / 0xffffff;
        out.push({ id: t.item.id, angle: h * Math.PI * 2, y: (h - 0.5) * 1.6, color });
      }
    }
    return out;
  }, [layout, escalationStatusByTrace, mountedAt]);

  const allPositions = useMemo<Vec3[]>(
    () => [...layout.products.map((p) => p.position), ...layout.vendors.map((p) => p.position), ...layout.rules.map((p) => p.position), layout.wallet],
    [layout]
  );

  return (
    <>
      <ambientLight intensity={0.45} />
      <pointLight position={[6, 8, 6]} intensity={40} />
      <pointLight position={[-6, -4, -6]} intensity={15} color={ENTITY_COLORS.purchaseOrder} />

      <Stars radius={60} depth={30} count={2200} factor={2.2} saturation={0} fade speed={0.4} />
      <Grid position={[0, -5.6, 0]} args={[40, 40]} cellSize={1} cellThickness={0.4} cellColor="#1c2030" sectionSize={5} sectionThickness={0.8} sectionColor="#2a3050" fadeDistance={26} fadeStrength={1.5} infiniteGrid />

      <WallShield
        flares={flares}
        color={pendingCount > 0 ? "#f5c04a" : ENTITY_COLORS.wall}
        onHover={(over) => setHover(over ? { kind: "wall", position: [0, 1.7, WALL_RADIUS] } : null)}
      />
      <PulseEdges edges={pulseEdges} />

      {layout.agents.map((p) => <AgentNode key={p.item.id} agent={p.item} position={p.position} onHover={setHover} />)}
      {layout.rules.map((p) => <RuleNode key={p.item.id} rule={p.item} position={p.position} onHover={setHover} />)}
      {layout.products.map((p) => <ProductNode key={p.item.id} product={p.item} position={p.position} maxValue={maxValue} onHover={setHover} />)}
      {layout.vendors.map((p) => <VendorNode key={p.item.id} vendor={p.item} position={p.position} onHover={setHover} />)}
      {layout.payees.map((p) => <PayeeNode key={p.item.id} payee={p.item} vendorName={vendorName.get(p.item.vendorId) ?? "supplier"} position={p.position} onHover={setHover} />)}
      {layout.purchaseOrders.map((p) => <PoNode key={p.item.id} po={p.item} vendorName={vendorName.get(p.item.vendorId) ?? "supplier"} position={p.position} onHover={setHover} />)}
      <WalletNode walletPaise={data.walletPaise} position={layout.wallet} onHover={setHover} />
      {layout.traces.map((p) => <TraceNode key={p.item.id} trace={p.item} position={p.position} escalationStatus={escalationStatusByTrace.get(p.item.id)} onHover={setHover} />)}

      <HoverPanel info={hover} />
      <FitToNodes positions={allPositions} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={4} maxDistance={32} />

      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={0.22} luminanceSmoothing={0.3} intensity={0.85} radius={0.6} />
        <Vignette eskil={false} offset={0.15} darkness={0.9} />
      </EffectComposer>
    </>
  );
}

export function GraphCanvas({ data, escalations, active = true }: { data: MapInput; escalations: Escalation[]; active?: boolean }) {
  return (
    <Canvas camera={{ position: [11, 8, 11], fov: 48 }} className="h-full w-full" dpr={[1, 1.75]} frameloop={active ? "always" : "never"}>
      <color attach="background" args={["#05060a"]} />
      <fog attach="fog" args={["#05060a", 16, 40]} />
      <Scene data={data} escalations={escalations} />
    </Canvas>
  );
}
