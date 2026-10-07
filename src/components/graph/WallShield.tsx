"use client";

import { useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, Color, DoubleSide, type ShaderMaterial, Vector4 } from "three";
import { WALL_HEIGHT, WALL_RADIUS } from "./layout";

/**
 * The Payment Wall, drawn.
 *
 * Every action an agent proposes has to get through it, so it is the centrepiece
 * of the scene rather than one node among many: a hex-lattice shield standing
 * around the agents, faint until something touches it. When a proposal crosses,
 * the wall answers where it was crossed, in the colour of the verdict: green for
 * allowed, amber for held for a person, red for refused. The flare spreads from
 * the crossing point as a ring and fades. Watching the wall flare red is the
 * product working.
 *
 * Up to {@link MAX_FLARES} are live at once. Older ones are simply dropped,
 * which is fine: a flare lasts a few seconds and the scene only ever shows
 * recent activity.
 */

export interface Flare {
  id: string;
  /** Angle around the wall, atan2(z, x), as returned by wallCrossing. */
  angle: number;
  /** Height on the wall. */
  y: number;
  color: string;
}

const MAX_FLARES = 8;
const FLARE_LIFETIME = 4.5;
const CIRCUMFERENCE = 2 * Math.PI * WALL_RADIUS;

const vertexShader = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPosition;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = `
#define MAX_FLARES ${MAX_FLARES}
uniform float uTime;
uniform vec3 uColor;
uniform float uCircumference;
uniform float uHeight;
uniform vec4 uFlare[MAX_FLARES];      // x = u around the wall, y = height, z = start time, w = live
uniform vec3 uFlareColor[MAX_FLARES];

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPosition;

// Distance to the nearest edge of a hexagonal cell, so 0 on a cell wall.
float hex(vec2 p) {
  p.x *= 1.1547;
  p.y += mod(floor(p.x), 2.0) * 0.5;
  p = abs(mod(p, 1.0) - 0.5);
  return abs(max(p.x * 1.5 + p.y, p.y * 2.0) - 1.0);
}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  // Brighter at grazing angles, so the shield reads as a surface with an edge
  // rather than as a flat sheet when seen face-on.
  float rim = pow(1.0 - clamp(abs(dot(normalize(vNormal), viewDir)), 0.0, 1.0), 2.4);

  vec2 cell = vec2(vUv.x * 46.0, vUv.y * 8.0);
  float edge = 1.0 - smoothstep(0.0, 0.07, hex(cell));

  // A slow band of light travelling up the wall: it is alive even when idle.
  float band = smoothstep(0.0, 0.5, 1.0 - abs(vUv.y - fract(uTime * 0.06)) * 5.0);

  vec3 col = uColor * (0.05 + edge * (0.16 + band * 0.5) + rim * 0.34);
  float alpha = 0.0;

  for (int i = 0; i < MAX_FLARES; i++) {
    if (uFlare[i].w < 0.5) continue;
    float du = abs(vUv.x - uFlare[i].x);
    du = min(du, 1.0 - du) * uCircumference;
    float dy = (vUv.y - 0.5) * uHeight - uFlare[i].y;
    float d = length(vec2(du, dy));
    float age = uTime - uFlare[i].z;
    // A ring spreading out from where the action crossed, and a bright core
    // that is gone almost at once.
    float ring = exp(-pow((d - age * 2.3) * 2.4, 2.0)) * exp(-age * 0.95);
    float core = exp(-d * d * 2.4) * exp(-age * 2.2);
    // The cells light up under the flare, not just the air in front of them.
    float lit = (ring * 1.5 + core * 2.1) * (0.55 + edge * 1.1);
    col += uFlareColor[i] * lit;
  }

  gl_FragColor = vec4(col, clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0));
}
`;

export function WallShield({
  flares,
  color,
  onHover,
}: {
  flares: Flare[];
  /** The wall's resting colour. It warms when a person is being waited on. */
  color: string;
  onHover?: (over: boolean) => void;
}) {
  const matRef = useRef<ShaderMaterial>(null);
  // When each flare first appeared, on the scene clock, so a flare plays from
  // its own start rather than from whenever the page loaded.
  const startedAt = useRef(new Map<string, number>());
  const [uniforms] = useState(() => ({
    uTime: { value: 0 },
    uColor: { value: new Color("#8b9cff") },
    uCircumference: { value: CIRCUMFERENCE },
    uHeight: { value: WALL_HEIGHT },
    uFlare: { value: Array.from({ length: MAX_FLARES }, () => new Vector4(0, 0, 0, 0)) },
    uFlareColor: { value: Array.from({ length: MAX_FLARES }, () => new Color("#ffffff")) },
  }));
  const ringColor = useMemo(() => new Color(color), [color]);

  useFrame(({ clock }) => {
    const mat = matRef.current;
    if (!mat) return;
    const now = clock.getElapsedTime();
    mat.uniforms.uTime.value = now;
    (mat.uniforms.uColor.value as Color).set(color);

    // Newest first, dropping anything older than its lifetime.
    const live: { f: Flare; t: number }[] = [];
    for (const f of flares) {
      if (!startedAt.current.has(f.id)) startedAt.current.set(f.id, now);
      const t = startedAt.current.get(f.id)!;
      if (now - t < FLARE_LIFETIME) live.push({ f, t });
    }
    live.sort((a, b) => b.t - a.t);
    const arr = mat.uniforms.uFlare.value as Vector4[];
    const cols = mat.uniforms.uFlareColor.value as Color[];
    for (let i = 0; i < MAX_FLARES; i++) {
      const hit = live[i];
      if (!hit) {
        arr[i].set(0, 0, 0, 0);
        continue;
      }
      // Cylinder UVs run with theta = atan2(x, z); the crossing gives atan2(z, x).
      const u = (Math.atan2(Math.cos(hit.f.angle), Math.sin(hit.f.angle)) / (2 * Math.PI) + 1) % 1;
      arr[i].set(u, hit.f.y, hit.t, 1);
      cols[i].set(hit.f.color);
    }
  });

  return (
    <group>
      {/* The shield. Never raycast: a surface this large would swallow every
          hover meant for the nodes behind it. */}
      <mesh raycast={() => null}>
        <cylinderGeometry args={[WALL_RADIUS, WALL_RADIUS, WALL_HEIGHT, 128, 1, true]} />
        <shaderMaterial
          ref={matRef}
          uniforms={uniforms}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          transparent
          depthWrite={false}
          side={DoubleSide}
          blending={AdditiveBlending}
        />
      </mesh>

      {/* The rims. The only part of the wall that takes hover. */}
      {[WALL_HEIGHT / 2, -WALL_HEIGHT / 2].map((y) => (
        <group key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <mesh>
            <torusGeometry args={[WALL_RADIUS, 0.022, 10, 160]} />
            <meshBasicMaterial color={ringColor} transparent opacity={0.85} blending={AdditiveBlending} depthWrite={false} />
          </mesh>
          <mesh onPointerOver={(e) => { e.stopPropagation(); onHover?.(true); }} onPointerOut={(e) => { e.stopPropagation(); onHover?.(false); }}>
            <torusGeometry args={[WALL_RADIUS, 0.16, 8, 64]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
