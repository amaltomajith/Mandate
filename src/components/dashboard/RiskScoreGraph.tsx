"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls, Stars } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import type { RiskOutcome, RiskSample, RiskSamplePoint } from "@/lib/risk/loadSample";
import { formatMoney } from "@/lib/format";

// Deliberately distinct from the live graph's decision colors (allow/block/
// escalate) — this is a different system making a different kind of claim
// (a held-out evaluation score, not a policy decision), and reusing the same
// colors would visually imply they're the same thing.
const OUTCOME_STYLE: Record<RiskOutcome, { color: string; label: string }> = {
  truePositive: { color: "#34d399", label: "Caught fraud" },
  falsePositive: { color: "#fbbf24", label: "False alarm" },
  falseNegative: { color: "#f87171", label: "Missed fraud" },
  trueNegative: { color: "#4b5566", label: "Correctly cleared (sampled)" },
};

const OUTCOME_ORDER: RiskOutcome[] = ["trueNegative", "falsePositive", "falseNegative", "truePositive"];

interface PositionedPoint extends RiskSamplePoint {
  position: [number, number, number];
}

function layoutPoints(points: RiskSamplePoint[]): PositionedPoint[] {
  const amounts = points.map((p) => Math.log1p(p.amount));
  const minAmount = Math.min(...amounts);
  const maxAmount = Math.max(...amounts) || 1;

  return points.map((p, i) => {
    const x = (p.prob - 0.5) * 16; // risk score, low (left) -> high (right)
    const normalizedAmount = (Math.log1p(p.amount) - minAmount) / (maxAmount - minAmount || 1);
    const y = normalizedAmount * 6 - 3; // transaction size, low (bottom) -> high (top)
    // Deterministic jitter (seeded by index) so depth spread doesn't reshuffle on re-render.
    const seed = Math.sin(i * 12.9898) * 43758.5453;
    const z = ((seed - Math.floor(seed)) - 0.5) * 6;
    return { ...p, position: [x, y, z] };
  });
}

function OutcomeCloud({
  outcome,
  points,
  onHover,
}: {
  outcome: RiskOutcome;
  points: PositionedPoint[];
  onHover: (p: PositionedPoint | null) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const style = OUTCOME_STYLE[outcome];
  const isNotable = outcome !== "trueNegative";

  // A ref mutation (setting each instance's transform matrix) is a side
  // effect, not a render-time computation — useLayoutEffect runs after the
  // instancedMesh exists but before paint, avoiding the "accessing refs
  // during render" pitfall a useMemo here would hit.
  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const m = new THREE.Matrix4();
    points.forEach((p, i) => {
      m.setPosition(...p.position);
      meshRef.current!.setMatrixAt(i, m);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [points]);

  useFrame(({ clock }) => {
    if (!meshRef.current || !isNotable) return;
    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.6 + Math.sin(clock.getElapsedTime() * 1.4) * 0.25;
  });

  if (points.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, points.length]}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (e.instanceId !== undefined) onHover(points[e.instanceId]);
      }}
      onPointerOut={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        onHover(null);
      }}
    >
      <sphereGeometry args={[isNotable ? 0.14 : 0.08, 10, 10]} />
      <meshStandardMaterial color={style.color} emissive={style.color} emissiveIntensity={isNotable ? 0.7 : 0.15} transparent opacity={isNotable ? 0.95 : 0.55} />
    </instancedMesh>
  );
}

function Tooltip({ point }: { point: PositionedPoint | null }) {
  if (!point) return null;
  const style = OUTCOME_STYLE[point.outcome];
  return (
    <Html position={point.position} style={{ pointerEvents: "none" }} zIndexRange={[100, 0]}>
      <div
        className="w-56 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-xl border px-3.5 py-3 shadow-2xl backdrop-blur-md"
        style={{ background: "rgba(9,11,18,0.97)", borderColor: "rgba(255,255,255,0.14)", color: "#f3f5fb" }}
      >
        <span
          className="mb-1.5 inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ background: `${style.color}26`, color: style.color }}
        >
          {style.label}
        </span>
        <p className="text-[12px] leading-relaxed" style={{ color: "#a4acc4" }}>
          Amount: {formatMoney(Math.round(point.amount * 100), "INR")}
        </p>
        <p className="text-[12px] leading-relaxed" style={{ color: "#a4acc4" }}>
          Model score: {(point.prob * 100).toFixed(1)}%
        </p>
      </div>
    </Html>
  );
}

function Scene({ sample }: { sample: RiskSample }) {
  const [hovered, setHovered] = useState<PositionedPoint | null>(null);
  const positioned = useMemo(() => layoutPoints(sample.points), [sample.points]);
  const byOutcome = useMemo(() => {
    const groups: Record<RiskOutcome, PositionedPoint[]> = { truePositive: [], falsePositive: [], falseNegative: [], trueNegative: [] };
    for (const p of positioned) groups[p.outcome].push(p);
    return groups;
  }, [positioned]);

  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[6, 8, 6]} intensity={35} />
      <pointLight position={[-6, -4, -6]} intensity={12} color="#a78bfa" />
      <Stars radius={50} depth={25} count={1400} factor={1.8} saturation={0} fade speed={0.3} />

      {OUTCOME_ORDER.map((outcome) => (
        <OutcomeCloud key={outcome} outcome={outcome} points={byOutcome[outcome]} onHover={setHovered} />
      ))}

      <Tooltip point={hovered} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={3} maxDistance={30} />

      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={0.2} luminanceSmoothing={0.3} intensity={0.7} radius={0.5} />
        <Vignette eskil={false} offset={0.15} darkness={0.9} />
      </EffectComposer>
    </>
  );
}

/**
 * The actual held-out PaySim test set, real scores and real outcomes,
 * rendered in its own <Canvas> — a separate Three.js scene from the live
 * Overview graph (GraphCanvas.tsx), never mounted at the same time (this
 * only renders inside the Risk tab), so it can't affect that graph's
 * performance. Never shows Mandate's own live transactions — see
 * HANDOVER.md §10 on why not.
 */
export function RiskScoreGraph({ sample }: { sample: RiskSample }) {
  return (
    <Canvas camera={{ position: [10, 6, 10], fov: 50 }} className="h-full w-full" dpr={[1, 1.75]}>
      <color attach="background" args={["#05060a"]} />
      <fog attach="fog" args={["#05060a", 16, 36]} />
      <Scene sample={sample} />
    </Canvas>
  );
}
