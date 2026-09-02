"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls, Stars } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import type * as THREE from "three";
import { Vector3 } from "three";
import type { Agent, Customer, Escalation, Mandate, PolicyRule, Trace } from "@/types/db";
import { computeLayout, type Vec3 } from "./layout";

/**
 * Frames the whole cluster on first load.
 *
 * The camera sat at a fixed position chosen when the graph held a handful of
 * nodes. As history accumulated the cluster grew past it — bottom clipped, two
 * thirds of the viewport empty — which reads as a broken render rather than as
 * a camera that needs moving.
 *
 * Runs once, not on every layout change: re-framing while someone is orbiting
 * would yank the view out from under them, and the whole point of the graph is
 * that it can be inspected by hand.
 */
function FitToNodes({ positions }: { positions: Vec3[] }) {
  const { camera } = useThree();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current || positions.length === 0) return;
    fitted.current = true;

    let max = 0;
    for (const [x, y, z] of positions) max = Math.max(max, Math.hypot(x, y, z));
    // A little past the outermost node, and never closer than the old default,
    // so a nearly-empty graph does not end up inside the cluster.
    const distance = Math.max(9, max * 1.9 + 3);
    const direction = new Vector3(1, 0.78, 1).normalize();
    camera.position.copy(direction.multiplyScalar(distance));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [positions, camera]);

  return null;
}
import { DECISION_COLORS, ENTITY_COLORS, traceColor } from "./colors";
import { actionTypeLabel, formatMoney } from "@/lib/format";

const RULE_TYPE_LABELS: Record<PolicyRule["type"], string> = {
  cap: "Spend cap",
  velocity: "Rate limit",
  category_block: "Category block",
  trust_floor: "Trust floor",
  step_up: "Step-up (needs approval)",
};

const DECISION_LABELS: Record<Trace["decision"], string> = {
  allow: "Allowed",
  block: "Blocked",
  escalate: "Escalated",
  protocol_reject: "Rejected — invalid signature",
};

/**
 * An escalation's decision never changes — the trace records that a human was
 * asked, and that stays true forever. Whether anyone has since *answered* is a
 * separate fact, living on the escalation row.
 *
 * Labelling from `trace.decision` alone conflated the two, so an escalation
 * approved hours ago still read "needs approval" for the rest of time. That
 * flatly contradicted the Escalations panel sitting beside it saying the queue
 * was clear, which makes the queue look broken rather than empty.
 */
const ESCALATION_STATUS_SUFFIX: Record<Escalation["status"], string> = {
  pending: " — needs approval",
  approved: " — approved",
  denied: " — denied",
};

const MANDATE_TYPE_LABELS: Record<Mandate["type"], string> = {
  upi_autopay: "UPI Autopay mandate",
  ap2_style: "AP2-style mandate",
};

const MANDATE_STATUS_COLORS: Record<Mandate["status"], string> = {
  active: DECISION_COLORS.allow,
  paused: DECISION_COLORS.escalate,
  revoked: DECISION_COLORS.block,
  expired: "#6b7280",
};

const MANDATE_STATUS_LABELS: Record<Mandate["status"], string> = {
  active: "Active — authorized",
  paused: "Paused by merchant",
  revoked: "Revoked — no longer authorized",
  expired: "Expired",
};

type HoverInfo =
  | { kind: "agent"; agent: Agent; position: Vec3 }
  | { kind: "rule"; rule: PolicyRule; position: Vec3 }
  | { kind: "trace"; trace: Trace; position: Vec3; escalationStatus?: Escalation["status"] }
  | { kind: "mandate"; mandate: Mandate; customerName: string; position: Vec3 }
  | null;

const MAX_VISIBLE_TRACES = 120;
const MAX_AGENT_EDGES_PER_AGENT = 15;

function AgentNode({
  agent,
  position,
  onHover,
}: {
  agent: Agent;
  position: Vec3;
  onHover: (h: HoverInfo) => void;
}) {
  const auraRef = useRef<THREE.Mesh>(null);
  const baseScale = 0.32 + (agent.trust_score / 100) * 0.34;

  useFrame(({ clock }) => {
    if (!auraRef.current) return;
    const breathe = 1 + Math.sin(clock.getElapsedTime() * 0.6 + position[0]) * 0.1;
    auraRef.current.scale.setScalar(baseScale * 2.1 * breathe);
  });

  return (
    <group
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover({ kind: "agent", agent, position });
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        onHover(null);
      }}
    >
      <mesh ref={auraRef}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial color={ENTITY_COLORS.agent} transparent opacity={0.1} depthWrite={false} />
      </mesh>
      <mesh scale={baseScale}>
        <sphereGeometry args={[1, 24, 24]} />
        <meshStandardMaterial
          color={ENTITY_COLORS.agent}
          emissive={ENTITY_COLORS.agent}
          emissiveIntensity={0.7}
          roughness={0.4}
        />
      </mesh>
    </group>
  );
}

function RuleNode({ rule, position, onHover }: { rule: PolicyRule; position: Vec3; onHover: (h: HoverInfo) => void }) {
  return (
    <mesh
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover({ kind: "rule", rule, position });
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        onHover(null);
      }}
    >
      <octahedronGeometry args={[0.4]} />
      <meshStandardMaterial color={ENTITY_COLORS.rule} emissive={ENTITY_COLORS.rule} emissiveIntensity={0.5} />
    </mesh>
  );
}

function MandateNode({
  mandate,
  customerName,
  position,
  onHover,
}: {
  mandate: Mandate;
  customerName: string;
  position: Vec3;
  onHover: (h: HoverInfo) => void;
}) {
  const statusColor = MANDATE_STATUS_COLORS[mandate.status];
  return (
    <group
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover({ kind: "mandate", mandate, customerName, position });
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        onHover(null);
      }}
    >
      <mesh scale={0.24}>
        <icosahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color={ENTITY_COLORS.mandate} emissive={ENTITY_COLORS.mandate} emissiveIntensity={0.5} />
      </mesh>
      {/* A colored ring keyed to status (active/paused/revoked) — same visual
          grammar as a trace's decision ring, so "this mandate isn't active
          anymore" reads the same way "this action was blocked" does. */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.36, 0.42, 24]} />
        <meshBasicMaterial color={statusColor} transparent opacity={0.85} depthWrite={false} side={2} />
      </mesh>
    </group>
  );
}

function TraceNode({
  trace,
  position,
  escalationStatus,
  onHover,
}: {
  trace: Trace;
  position: Vec3;
  escalationStatus?: Escalation["status"];
  onHover: (h: HoverInfo) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const shockwaveRef = useRef<THREE.Mesh>(null);
  // useState's lazy initializer is the sanctioned way to capture an impure value
  // like Date.now() exactly once at mount (a plain useRef(Date.now()) read during
  // render trips the react-hooks purity rule).
  const [mountedAt] = useState(() => Date.now());
  const isFresh = (mountedAt - new Date(trace.created_at).getTime()) / 1000 < 6;
  const decisionColor = traceColor(trace.decision, escalationStatus);
  const isSevere = trace.decision === "block" || trace.decision === "protocol_reject";

  // The scene clock is shared across every node and keeps running for the
  // life of the Canvas — using it directly meant a node that mounted a minute
  // into the session read an elapsed time already far past its own animation
  // window, so its "fresh" pulse rendered pre-faded instead of playing. This
  // ref captures each node's OWN start time on its first frame instead.
  const localStartRef = useRef<number | null>(null);

  useFrame(({ clock }) => {
    if (localStartRef.current === null) localStartRef.current = clock.getElapsedTime();
    const localElapsed = clock.getElapsedTime() - localStartRef.current;

    // Materialize-in: every node scales up from nothing on its first ~0.35s,
    // fresh or not — this is what makes new activity read as something
    // *appearing* in a live simulation rather than popping into existence.
    if (groupRef.current) {
      const growth = Math.min(localElapsed / 0.35, 1);
      const eased = 1 - Math.pow(1 - growth, 3);
      groupRef.current.scale.setScalar(eased);
    }

    if (ringRef.current) {
      const mat = ringRef.current.material as THREE.MeshBasicMaterial;
      if (!isFresh) {
        ringRef.current.scale.setScalar(1);
        mat.opacity = 0.28;
      } else {
        const t = Math.min(localElapsed / 2.2, 1);
        ringRef.current.scale.setScalar(1.9 - t * 0.9);
        mat.opacity = 0.9 - t * 0.62;
      }
    }

    // A block/rejection gets a second, bigger ring that bursts outward and
    // fades — visually distinct from the calm allow/escalate pulse, so a
    // blocked action reads as a stop, not just a different-colored dot.
    if (shockwaveRef.current) {
      if (isFresh && isSevere) {
        const t = Math.min(localElapsed / 1.1, 1);
        const mat = shockwaveRef.current.material as THREE.MeshBasicMaterial;
        shockwaveRef.current.scale.setScalar(1 + t * 5);
        mat.opacity = (1 - t) * 0.6;
        shockwaveRef.current.visible = t < 1;
      } else {
        shockwaveRef.current.visible = false;
      }
    }
  });

  return (
    <group
      ref={groupRef}
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover({ kind: "trace", trace, position, escalationStatus });
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        onHover(null);
      }}
    >
      <mesh scale={0.16}>
        <sphereGeometry args={[1, 12, 12]} />
        <meshStandardMaterial color={ENTITY_COLORS.transaction} />
      </mesh>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.24, 0.3, 24]} />
        <meshBasicMaterial color={decisionColor} transparent opacity={0.5} depthWrite={false} side={2} />
      </mesh>
      {isSevere && (
        <mesh ref={shockwaveRef} rotation={[Math.PI / 2, 0, 0]} visible={false}>
          <ringGeometry args={[0.32, 0.36, 32]} />
          <meshBasicMaterial color={decisionColor} transparent opacity={0} depthWrite={false} side={2} />
        </mesh>
      )}
    </group>
  );
}

function Edge({ from, to, color, opacity, dashed }: { from: Vec3; to: Vec3; color: string; opacity: number; dashed?: boolean }) {
  return <Line points={[from, to]} color={color} opacity={opacity} transparent dashed={dashed} lineWidth={1} />;
}

function HoverPanel({ info }: { info: HoverInfo }) {
  if (!info) return null;

  let title = "";
  let badge: { text: string; color: string } | null = null;
  let lines: string[] = [];

  if (info.kind === "agent") {
    title = info.agent.name;
    badge = { text: "AI agent", color: ENTITY_COLORS.agent };
    lines = [
      `Trust score ${info.agent.trust_score.toFixed(0)}/100 — bigger, steadier glow means a cleaner track record.`,
      info.agent.description ?? "",
    ];
  } else if (info.kind === "rule") {
    title = info.rule.name;
    badge = { text: RULE_TYPE_LABELS[info.rule.type], color: ENTITY_COLORS.rule };
    lines = [info.rule.rationale ?? "No extra detail recorded for this rule."];
  } else if (info.kind === "mandate") {
    title = `${MANDATE_TYPE_LABELS[info.mandate.type]} · ${info.customerName}`;
    badge = { text: MANDATE_STATUS_LABELS[info.mandate.status], color: MANDATE_STATUS_COLORS[info.mandate.status] };
    lines = [
      info.mandate.status === "active"
        ? "This agent is authorized to act on this customer's behalf. Pause or revoke it from the Mandates tab."
        : "Every action this agent attempts under this mandate is now blocked, regardless of what policy would otherwise allow.",
    ];
  } else {
    const p = info.trace.params as { amount?: number; currency?: string } | null;
    title = actionTypeLabel(info.trace.action_type) + (p?.amount && p?.currency ? ` · ${formatMoney(p.amount, p.currency)}` : "");
    // A trace with no escalation row at all is one that never needed a human;
    // only append a status when there is genuinely one to report.
    const escalationStatus = info.escalationStatus;
    const suffix =
      info.trace.decision === "escalate" && escalationStatus ? ESCALATION_STATUS_SUFFIX[escalationStatus] : "";
    badge = {
      text: DECISION_LABELS[info.trace.decision] + suffix,
      color: traceColor(info.trace.decision, escalationStatus),
    };
    lines = [info.trace.reasoning ?? ""];
  }

  return (
    // No `distanceFactor` on purpose: it CSS-scales the overlay by distance
    // from the camera to fake perspective, which made this tooltip shrink to
    // near-illegible for any node that wasn't right up against the lens.
    // Dropping it renders Html at a constant screen-space size — readable
    // regardless of zoom, which is what a hover label needs to be.
    <Html position={info.position} style={{ pointerEvents: "none" }} zIndexRange={[100, 0]}>
      {/* Hardcoded dark colors, not the (light-theme) CSS vars — this tooltip
          floats over the graph's own dark canvas, not the light dashboard shell. */}
      <div
        className="w-72 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-xl border px-3.5 py-3 shadow-2xl backdrop-blur-md"
        style={{ background: "rgba(8,8,12,0.97)", borderColor: "rgba(255,255,255,0.14)", color: "#f3f1fb" }}
      >
        <p className="mb-1.5 text-[13px] font-semibold leading-snug">{title}</p>
        {badge && (
          <span
            className="mb-1.5 inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{ background: `${badge.color}26`, color: badge.color }}
          >
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

function Scene({
  agents,
  rules,
  traces,
  mandates,
  customers,
  escalations,
}: {
  agents: Agent[];
  rules: PolicyRule[];
  traces: Trace[];
  mandates: Mandate[];
  customers: Customer[];
  escalations: Escalation[];
}) {
  const [hover, setHover] = useState<HoverInfo>(null);
  const visibleTraces = useMemo(() => traces.slice(0, MAX_VISIBLE_TRACES), [traces]);
  // Whether an escalation has been answered lives on the escalation row, not
  // the trace — see ESCALATION_STATUS_SUFFIX for why that distinction matters.
  const escalationStatusByTrace = useMemo(
    () => new Map(escalations.map((e) => [e.trace_id, e.status])),
    [escalations]
  );
  const layout = useMemo(
    () => computeLayout(agents, rules, visibleTraces, mandates),
    [agents, rules, visibleTraces, mandates]
  );
  const customerNameById = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);

  const tracePositionById = useMemo(
    () => new Map(layout.traces.map((t) => [t.trace.id, t.position])),
    [layout.traces]
  );

  const agentEdges = useMemo(() => {
    const edges: { from: Vec3; to: Vec3; agentColor: string }[] = [];
    for (const [agentId, base] of Object.entries(layout.agentPositionById)) {
      const own = layout.traces.filter((t) => t.trace.agent_id === agentId).slice(-MAX_AGENT_EDGES_PER_AGENT);
      for (const t of own) edges.push({ from: base, to: t.position, agentColor: ENTITY_COLORS.agent });
    }
    return edges;
  }, [layout]);

  const ruleEdges = useMemo(() => {
    const edges: { from: Vec3; to: Vec3; color: string }[] = [];
    for (const t of layout.traces) {
      if (!t.trace.rule_fired_id) continue;
      const rulePos = layout.rulePositionById[t.trace.rule_fired_id];
      if (!rulePos) continue;
      edges.push({
        from: t.position,
        to: rulePos,
        color: traceColor(t.trace.decision, escalationStatusByTrace.get(t.trace.id)),
      });
    }
    return edges;
  }, [layout, escalationStatusByTrace]);

  const forkEdges = useMemo(() => {
    const edges: { from: Vec3; to: Vec3 }[] = [];
    for (const t of layout.traces) {
      if (!t.trace.parent_trace_id) continue;
      const parentPos = tracePositionById.get(t.trace.parent_trace_id);
      if (!parentPos) continue;
      edges.push({ from: t.position, to: parentPos });
    }
    return edges;
  }, [layout, tracePositionById]);

  const mandateEdges = useMemo(() => {
    const edges: { from: Vec3; to: Vec3; color: string }[] = [];
    for (const m of layout.mandates) {
      const agentPos = m.mandate.agent_id ? layout.agentPositionById[m.mandate.agent_id] : null;
      if (!agentPos) continue;
      edges.push({ from: agentPos, to: m.position, color: MANDATE_STATUS_COLORS[m.mandate.status] });
    }
    return edges;
  }, [layout]);

  return (
    <>
      <ambientLight intensity={0.45} />
      <pointLight position={[6, 8, 6]} intensity={40} />
      <pointLight position={[-6, -4, -6]} intensity={15} color={ENTITY_COLORS.mandate} />

      <Stars radius={60} depth={30} count={2200} factor={2.2} saturation={0} fade speed={0.4} />
      <Grid
        position={[0, -5.4, 0]}
        args={[40, 40]}
        cellSize={1}
        cellThickness={0.4}
        cellColor="#1c2030"
        sectionSize={5}
        sectionThickness={0.8}
        sectionColor="#2a3050"
        fadeDistance={26}
        fadeStrength={1.5}
        infiniteGrid
      />

      {agentEdges.map((e, i) => (
        <Edge key={`ae-${i}`} from={e.from} to={e.to} color={e.agentColor} opacity={0.12} />
      ))}
      {ruleEdges.map((e, i) => (
        <Edge key={`re-${i}`} from={e.from} to={e.to} color={e.color} opacity={0.25} />
      ))}
      {/* A parent link means "this action exists because that one did" — which
          in practice is the agent upselling off a purchase. Coloured as the
          revenue relationship it is, rather than the neutral white it used to
          be when the only parent links were forked simulations. */}
      {forkEdges.map((e, i) => (
        <Edge key={`fe-${i}`} from={e.from} to={e.to} color={ENTITY_COLORS.mandate} opacity={0.45} dashed />
      ))}
      {mandateEdges.map((e, i) => (
        <Edge key={`me-${i}`} from={e.from} to={e.to} color={e.color} opacity={0.4} />
      ))}
      {layout.agents.map((p) => (
        <AgentNode key={p.agent.id} agent={p.agent} position={p.position} onHover={setHover} />
      ))}
      {layout.rules.map((p) => (
        <RuleNode key={p.rule.id} rule={p.rule} position={p.position} onHover={setHover} />
      ))}
      {layout.mandates.map((p) => (
        <MandateNode
          key={p.mandate.id}
          mandate={p.mandate}
          customerName={p.mandate.customer_id ? customerNameById.get(p.mandate.customer_id) ?? "Unknown customer" : "Unknown customer"}
          position={p.position}
          onHover={setHover}
        />
      ))}
      {layout.traces.map((p) => (
        <TraceNode
          key={p.trace.id}
          trace={p.trace}
          position={p.position}
          escalationStatus={escalationStatusByTrace.get(p.trace.id)}
          onHover={setHover}
        />
      ))}

      <HoverPanel info={hover} />
      <FitToNodes positions={layout.traces.map((t) => t.position)} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={3} maxDistance={30} />

      <EffectComposer multisampling={0}>
        <Bloom
          mipmapBlur
          luminanceThreshold={0.15}
          luminanceSmoothing={0.3}
          intensity={0.9}
          radius={0.6}
        />
        <Vignette eskil={false} offset={0.15} darkness={0.9} />
      </EffectComposer>
    </>
  );
}

export function GraphCanvas({
  agents,
  rules,
  traces,
  mandates = [],
  customers = [],
  escalations = [],
}: {
  agents: Agent[];
  rules: PolicyRule[];
  traces: Trace[];
  mandates?: Mandate[];
  customers?: Customer[];
  escalations?: Escalation[];
}) {
  return (
    <Canvas camera={{ position: [9, 7, 9], fov: 50 }} className="h-full w-full" dpr={[1, 1.75]}>
      <color attach="background" args={["#05060a"]} />
      <fog attach="fog" args={["#05060a", 14, 34]} />
      <Scene agents={agents} rules={rules} traces={traces} mandates={mandates} customers={customers} escalations={escalations} />
    </Canvas>
  );
}
