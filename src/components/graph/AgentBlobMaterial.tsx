"use client";

import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, type ShaderMaterial } from "three";

/**
 * An organic, noise-displaced, glow-rimmed sphere — the visual asked for by
 * React Bits Pro's "AI Blob" (`@reactbits-starter/ai-blob-tw`), which is
 * gated behind a Pro license key this deployment doesn't have (confirmed live
 * with the actual install command, same wall `simple-graph` hit). Hand-rolled
 * instead, in the exact technique this project already uses for its other
 * generative visual — the landing page's `GradientWaves` hero is a raymarched
 * fragment shader; this is a vertex-displaced one, same house style, now
 * inside the entity graph's own three.js/react-three-fiber scene rather than
 * `ogl`.
 *
 * The noise function is the standard Ashima Arts 3D simplex noise (MIT/public
 * domain, the same implementation nearly every GLSL blob/terrain/cloud effect
 * on the web is built on) — inlined as a template literal, matching how
 * GradientWaves.tsx inlines its own ~150-line fragment shader rather than
 * pulling in a shader-chunk dependency for one function.
 *
 * AMPLITUDE AND SPEED ARE TIED TO TRUST, not arbitrary. A calmer, more
 * spherical blob for a high-trust agent and a more agitated, wobbling one for
 * a low-trust agent is a real mapping from this app's own data — the same
 * discipline every other visual in this scene follows (colour by verdict,
 * size by trust) — rather than motion added purely for spectacle.
 */

const SIMPLEX_NOISE_GLSL = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const vertexShader = `
uniform float uTime;
uniform float uAmplitude;
uniform float uFrequency;
varying vec3 vNormal;
varying vec3 vWorldPosition;

${SIMPLEX_NOISE_GLSL}

void main() {
  vNormal = normalize(normalMatrix * normal);
  float n = snoise(position * uFrequency + vec3(0.0, 0.0, uTime * 0.35));
  vec3 displaced = position + normal * n * uAmplitude;
  vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = `
uniform vec3 uColor;
varying vec3 vNormal;
varying vec3 vWorldPosition;

void main() {
  // Fresnel: the rim (where the surface normal points away from the camera)
  // glows; the face pointed at the viewer stays a duller, saturated core --
  // the same "brighter at the edge than the middle" read every glass/plasma
  // shader uses, and what makes this feel lit rather than flat-painted.
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), viewDir), 0.0, 1.0), 2.2);
  vec3 color = uColor * 0.5 + uColor * fresnel * 2.0;
  gl_FragColor = vec4(color, 1.0);
}
`;

export function AgentBlobCore({
  color,
  scale,
  trustScore,
}: {
  color: string;
  scale: number;
  /** 0-100. Drives how agitated the blob's surface reads — see the module
   *  doc comment for why this is tied to real data rather than decorative. */
  trustScore: number;
}) {
  const materialRef = useRef<ShaderMaterial>(null);

  // Low trust -> larger amplitude, faster-feeling wobble (higher spatial
  // frequency reads as more "restless" even at the same time-scale). High
  // trust -> a calmer, closer-to-spherical surface. Clamped so even a 0-trust
  // agent stays recognisably a blob, not a spike ball, and even a 100-trust
  // agent still visibly breathes rather than looking static/dead.
  const t = Math.max(0, Math.min(100, trustScore)) / 100;
  const amplitude = 0.34 - t * 0.22; // 0.34 .. 0.12
  const frequency = 2.6 - t * 0.9; // 2.6 .. 1.7

  // useState's lazy initializer, not useMemo and not a ref read during
  // render. Three separate constraints all have to hold at once: the object
  // has to exist at RENDER time (it's handed to <shaderMaterial uniforms={}>
  // as a prop, which R3F reads once to build the material), it has to be
  // MUTATED every frame afterward (the standard, performance-correct way to
  // drive a shader — replacing it each frame would make R3F treat it as a
  // changed prop and recompile the whole shader program instead of updating a
  // float), and the setter is NEVER called again, so React never re-renders
  // because of it. A ref satisfies the second constraint but not the first —
  // reading `.current` during render is exactly what tripped the
  // GradientWaves fallback-layer fix earlier this session. useState's
  // returned value is safe to read during render by contract; only its
  // OUTER reference needs to stay stable for that, and it does, since setUniforms
  // is deliberately unused past this line.
  const [uniforms] = useState(() => ({
    uTime: { value: 0 },
    uAmplitude: { value: amplitude },
    uFrequency: { value: frequency },
    uColor: { value: new Color(color) },
  }));

  // Only fires if `color` itself changes identity, which it doesn't for the
  // one caller today (ENTITY_COLORS.agent is a module-level constant) — kept
  // correct anyway rather than assuming the prop can never change.
  useEffect(() => {
    uniforms.uColor.value.set(color);
  }, [color, uniforms]);

  // Mutating an existing uniform's `.value` every frame is three.js's own
  // documented contract for driving a shader (the same pattern drei's
  // `shaderMaterial` helper and the official R3F examples use), not an
  // accidental state mutation. The rule below is tuned for React state/memo
  // semantics and has no exception for the WebGL uniform-update convention;
  // REPLACING this object each frame instead (the "fix" it would accept)
  // would make R3F treat `uniforms` as a changed prop and force three.js to
  // rebuild the shader program every frame — strictly worse than what it's
  // flagging. Block-disabled rather than per-line: the directive has to sit
  // directly above the mutating statements themselves, not above `useFrame(`,
  // or it silences nothing and the real violation still fires a few lines
  // down — which is exactly the mistake the first version of this comment
  // made.
  useFrame(({ clock }) => {
    /* eslint-disable react-hooks/immutability */
    uniforms.uTime.value = clock.getElapsedTime();
    uniforms.uAmplitude.value = amplitude;
    uniforms.uFrequency.value = frequency;
    /* eslint-enable react-hooks/immutability */
  });

  return (
    <mesh scale={scale}>
      <sphereGeometry args={[1, 64, 64]} />
      <shaderMaterial ref={materialRef} uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} />
    </mesh>
  );
}
