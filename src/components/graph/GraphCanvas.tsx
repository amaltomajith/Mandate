"use client";

import { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls, Stars } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import type * as THREE from "three";
import type { Agent, PolicyRule, Trace } from "@/types/db";
import { computeLayout, type Vec3 } from "./layout";
import { DECISION_COLORS, ENTITY_COLORS } from "./colors";

type HoverInfo =
  | { kind: "agent"; agent: Agent; position: Vec3 }
  | { kind: "rule"; rule: PolicyRule; position: Vec3 }
  | { kind: "trace"; trace: Trace; position: Vec3 }
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

function TraceNode({ trace, position, onHover }: { trace: Trace; position: Vec3; onHover: (h: HoverInfo) => void }) {
  const ringRef = useRef<THREE.Mesh>(null);
  // useState's lazy initializer is the sanctioned way to capture an impure value
  // like Date.now() exactly once at mount (a plain useRef(Date.now()) read during
  // render trips the react-hooks purity rule).
  const [mountedAt] = useState(() => Date.now());
  const isFresh = (mountedAt - new Date(trace.created_at).getTime()) / 1000 < 6;
  const decisionColor = DECISION_COLORS[trace.decision];

  useFrame(({ clock }) => {
    if (!ringRef.current) return;
    const mat = ringRef.current.material as THREE.MeshBasicMaterial;
    if (!isFresh) {
      ringRef.current.scale.setScalar(1);
      mat.opacity = 0.28;
      return;
    }
    const t = Math.min(clock.getElapsedTime() / 2.2, 1);
    ringRef.current.scale.setScalar(1.9 - t * 0.9);
    mat.opacity = 0.9 - t * 0.62;
  });

  return (
    <group
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover({ kind: "trace", trace, position });
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
    </group>
  );
}

function Edge({ from, to, color, opacity, dashed }: { from: Vec3; to: Vec3; color: string; opacity: number; dashed?: boolean }) {
  return <Line points={[from, to]} color={color} opacity={opacity} transparent dashed={dashed} lineWidth={1} />;
}

function HoverPanel({ info }: { info: HoverInfo }) {
  if (!info) return null;

  let title = "";
  let lines: string[] = [];

  if (info.kind === "agent") {
    title = info.agent.name;
    lines = [`trust score: ${info.agent.trust_score.toFixed(0)}/100`, info.agent.description ?? "agent identity"];
  } else if (info.kind === "rule") {
    title = info.rule.name;
    lines = [`type: ${info.rule.type}`, info.rule.rationale ?? ""];
  } else {
    title = info.trace.action_type;
    lines = [`decision: ${info.trace.decision}`, info.trace.reasoning ?? ""];
  }

  return (
    <Html position={info.position} distanceFactor={8} style={{ pointerEvents: "none" }}>
      {/* Hardcoded dark colors, not the (light-theme) CSS vars — this tooltip
          floats over the graph's own dark canvas, not the light dashboard shell. */}
      <div
        className="w-56 rounded-lg border px-3 py-2 text-xs shadow-xl backdrop-blur-sm"
        style={{ background: "rgba(13,15,22,0.94)", borderColor: "rgba(255,255,255,0.12)", color: "#eef0f7" }}
      >
        <p className="mb-1 font-semibold">{title}</p>
        {lines.filter(Boolean).map((line, i) => (
          <p key={i} style={{ color: "#8890a8" }}>
            {line}
          </p>
        ))}
      </div>
    </Html>
  );
}

function Scene({ agents, rules, traces }: { agents: Agent[]; rules: PolicyRule[]; traces: Trace[] }) {
  const [hover, setHover] = useState<HoverInfo>(null);
  const visibleTraces = useMemo(() => traces.slice(0, MAX_VISIBLE_TRACES), [traces]);
  const layout = useMemo(() => computeLayout(agents, rules, visibleTraces), [agents, rules, visibleTraces]);

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
      edges.push({ from: t.position, to: rulePos, color: DECISION_COLORS[t.trace.decision] });
    }
    return edges;
  }, [layout]);

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
      {forkEdges.map((e, i) => (
        <Edge key={`fe-${i}`} from={e.from} to={e.to} color="#ffffff" opacity={0.3} dashed />
      ))}

      {layout.agents.map((p) => (
        <AgentNode key={p.agent.id} agent={p.agent} position={p.position} onHover={setHover} />
      ))}
      {layout.rules.map((p) => (
        <RuleNode key={p.rule.id} rule={p.rule} position={p.position} onHover={setHover} />
      ))}
      {layout.traces.map((p) => (
        <TraceNode key={p.trace.id} trace={p.trace} position={p.position} onHover={setHover} />
      ))}

      <HoverPanel info={hover} />
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

export function GraphCanvas({ agents, rules, traces }: { agents: Agent[]; rules: PolicyRule[]; traces: Trace[] }) {
  return (
    <Canvas camera={{ position: [9, 7, 9], fov: 50 }} className="h-full w-full" dpr={[1, 1.75]}>
      <color attach="background" args={["#05060a"]} />
      <fog attach="fog" args={["#05060a", 14, 34]} />
      <Scene agents={agents} rules={rules} traces={traces} />
    </Canvas>
  );
}
