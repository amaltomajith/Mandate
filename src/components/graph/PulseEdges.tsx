"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AddEquation,
  BufferGeometry,
  Color,
  CustomBlending,
  Float32BufferAttribute,
  OneFactor,
  type ShaderMaterial,
} from "three";
import type { Vec3 } from "./layout";

/**
 * Every edge in the scene, drawn as ONE object with a travelling pulse running
 * along each line.
 *
 * WHY ONE OBJECT. The graph draws a couple of hundred edges. Giving each its
 * own line and material would mean a couple of hundred materials whose time
 * uniform has to be written every frame — and react-three-fiber hands a
 * material its own copy of the uniforms object rather than the one passed as a
 * prop, so each would need its own ref and its own per-frame write. Merging
 * everything into a single geometry makes it one draw call and one uniform
 * write, with the per-edge differences (colour, base opacity, pulse phase,
 * dashing) carried as vertex attributes instead.
 *
 * DIRECTION. The pulse always travels toward an edge's `from` endpoint, and
 * the edge lists are built so that endpoint is the one the movement should
 * arrive at: an action's pulse runs up into its agent, a mandate's into the
 * agent it authorises, a rule's down into the action it fired on, and a fork's
 * from parent into child. One rule, and it reads correctly for all four.
 *
 * Phases are staggered by the golden ratio rather than randomly, so the pulses
 * never arrive in lockstep and the scene still renders identically on every
 * load — the layout is deterministic and this stays consistent with that.
 */

export interface PulseEdge {
  from: Vec3;
  to: Vec3;
  color: string;
  /** Resting brightness of the line, before any pulse. */
  opacity: number;
  dashed?: boolean;
}

/** Points along each edge. The pulse is evaluated per fragment, so this only
 *  has to be fine enough that a straight line stays straight — but the shader
 *  interpolates `aT` between vertices, so too few would make the pulse step. */
const SEGMENTS = 24;

const vertexShader = `
attribute float aT;
attribute vec3 aColor;
attribute float aOpacity;
attribute float aPhase;
attribute float aDash;

varying float vT;
varying vec3 vColor;
varying float vOpacity;
varying float vPhase;
varying float vDash;

void main() {
  vT = aT;
  vColor = aColor;
  vOpacity = aOpacity;
  vPhase = aPhase;
  vDash = aDash;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
uniform float uTime;
uniform float uSpeed;
uniform float uWidth;
uniform float uPulse;

varying float vT;
varying vec3 vColor;
varying float vOpacity;
varying float vPhase;
varying float vDash;

void main() {
  // Fork edges stay dashed, as they were before: a fork is a different kind of
  // relationship from a causal edge and should not read the same.
  if (vDash > 0.5 && fract(vT * 26.0) > 0.55) discard;

  // The head runs toward t = 0, which is the edge's "from" endpoint.
  float head = fract(vPhase - uTime * uSpeed);

  // Wrapped distance to the head, so the pulse crosses the seam cleanly
  // instead of vanishing and reappearing at the ends.
  float d = abs(fract(vT - head + 0.5) - 0.5);
  float pulse = exp(-(d * d) / (uWidth * uWidth));

  // A comet, not a uniform brightening: the line keeps its resting level and
  // the pulse rides on top of it.
  float intensity = vOpacity + pulse * uPulse;

  // Alpha carries coverage and never scales the colour — the material blends
  // One/One. Outputting a constant 1.0 here would stamp the line's full
  // bounding geometry opaque over the starfield, the same defect the agent
  // node's quad had.
  gl_FragColor = vec4(vColor * intensity, clamp(intensity, 0.0, 1.0));
}
`;

export function PulseEdges({ edges }: { edges: PulseEdge[] }) {
  const materialRef = useRef<ShaderMaterial>(null);

  const geometry = useMemo(() => {
    const positions: number[] = [];
    const ts: number[] = [];
    const colors: number[] = [];
    const opacities: number[] = [];
    const phases: number[] = [];
    const dashes: number[] = [];
    const c = new Color();

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      // Color.set converts sRGB to the linear working space, matching how
      // every other colour in this scene reaches its shader.
      c.set(e.color);
      const phase = (i * 0.6180339887498949) % 1;
      const dash = e.dashed ? 1 : 0;

      for (let s = 0; s < SEGMENTS; s++) {
        // LineSegments consumes vertices in pairs, so each step emits both
        // ends of its own segment.
        for (const t of [s / SEGMENTS, (s + 1) / SEGMENTS]) {
          positions.push(
            e.from[0] + (e.to[0] - e.from[0]) * t,
            e.from[1] + (e.to[1] - e.from[1]) * t,
            e.from[2] + (e.to[2] - e.from[2]) * t
          );
          ts.push(t);
          colors.push(c.r, c.g, c.b);
          opacities.push(e.opacity);
          phases.push(phase);
          dashes.push(dash);
        }
      }
    }

    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(positions, 3));
    g.setAttribute("aT", new Float32BufferAttribute(ts, 1));
    g.setAttribute("aColor", new Float32BufferAttribute(colors, 3));
    g.setAttribute("aOpacity", new Float32BufferAttribute(opacities, 1));
    g.setAttribute("aPhase", new Float32BufferAttribute(phases, 1));
    g.setAttribute("aDash", new Float32BufferAttribute(dashes, 1));
    return g;
  }, [edges]);

  // The edge list is rebuilt whenever the graph polls, so without this the
  // discarded geometries' GPU buffers would accumulate for as long as the
  // dashboard stays open.
  useEffect(() => () => geometry.dispose(), [geometry]);

  const [uniforms] = useState(() => ({
    uTime: { value: 0 },
    uSpeed: { value: 0.32 },
    uWidth: { value: 0.075 },
    uPulse: { value: 0.85 },
  }));

  useFrame(({ clock }) => {
    // Written through the material, not through the object above: R3F does not
    // give the material that object. See AgentBlobMaterial for the full note.
    const m = materialRef.current;
    if (m) m.uniforms.uTime.value = clock.getElapsedTime();
  });

  if (edges.length === 0) return null;

  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={CustomBlending}
        blendEquation={AddEquation}
        blendSrc={OneFactor}
        blendDst={OneFactor}
        blendSrcAlpha={OneFactor}
        blendDstAlpha={OneFactor}
      />
    </lineSegments>
  );
}
