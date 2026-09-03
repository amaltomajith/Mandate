"use client";

import { useEffect, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard } from "@react-three/drei";
import { AdditiveBlending, Color } from "three";

/**
 * The agent node's visual — the look React Bits Pro's "AI Blob"
 * (`@reactbits-starter/ai-blob-tw`) produces. That component is gated behind a
 * Pro license key this deployment doesn't have; confirmed live again with the
 * exact install command, which fails on `Unknown registry "@reactbits-starter"`
 * for want of a registry URL. Hand-rolled instead, in the technique this
 * project already uses for its other generative visual — the landing page's
 * `GradientWaves` hero is a raymarched fragment shader; this is a
 * vertex-displaced one, same house style, inside the entity graph's own
 * three.js scene.
 *
 * STRUCTURE, which is the part the first attempt got wrong. The reference is
 * not a big glowing sphere: it is a THIN, crisp ring with a SMALL, intensely
 * hot organic blob floating at its centre and mostly empty dark space between
 * the two. The first pass built a large pale lumpy sphere wrapped in soft
 * additive fog, which read as a lit moon rather than a contained plasma. The
 * ratio matters as much as the shading — the blob is roughly a quarter of the
 * ring's diameter.
 *
 * Brightness is deliberately pushed well past 1.0 on the core. This scene runs
 * a Bloom pass, and a small, genuinely over-bright object is what makes bloom
 * produce a saturated glow bleeding outward from a white-hot centre. Painting
 * a large surface at moderate brightness — the first attempt — gives bloom
 * nothing to work with and washes out to grey-white instead.
 *
 * The noise function is the standard Ashima Arts 3D simplex noise (MIT/public
 * domain, what nearly every GLSL blob/terrain/cloud effect on the web is built
 * on) — inlined as a template literal, matching how GradientWaves.tsx inlines
 * its own fragment shader rather than adding a shader-chunk dependency.
 *
 * AMPLITUDE AND SWEEP SPEED ARE TIED TO TRUST, not arbitrary: a calmer, more
 * spherical core and a slower ring sweep for a high-trust agent, a more
 * agitated one for a low-trust agent. That is a real mapping from this app's
 * own data, the same discipline the rest of the scene follows (colour by
 * entity type, size by trust), rather than motion added for spectacle.
 *
 * NOTE ON BACKTICKS: these shaders live inside JS template literals, so a
 * backtick anywhere in a GLSL comment terminates the string. Use quotes.
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

const coreVertexShader = `
uniform float uTime;
uniform float uAmplitude;
uniform float uFrequency;
varying vec3 vNormal;
varying vec3 vWorldPosition;
varying float vNoise;

${SIMPLEX_NOISE_GLSL}

void main() {
  vNormal = normalize(normalMatrix * normal);
  float n = snoise(position * uFrequency + vec3(0.0, 0.0, uTime * 0.35));
  vNoise = n;
  vec3 displaced = position + normal * n * uAmplitude;
  vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const coreFragmentShader = `
uniform vec3 uColor;
varying vec3 vNormal;
varying vec3 vWorldPosition;
varying float vNoise;

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  vec3 n = normalize(vNormal);

  float facing = clamp(dot(n, viewDir), 0.0, 1.0);

  // The body is kept close to 1.0 ON PURPOSE, and this is the whole lesson of
  // this shader. Multiplying a saturated colour far past 1.0 does not make it
  // a brighter version of itself -- its strongest channel pins first and the
  // others catch up, so the hue slides to cyan and then to flat white. An
  // offscreen render of these exact shaders showed precisely that: a
  // near-white ball with a thin blue edge. Bloom's threshold in this scene is
  // 0.22, well under this, so a body at ~1.0 still blooms while keeping its
  // colour.
  float body = 0.85 + 0.25 * facing;

  // A TIGHT central hotspot. The steep exponent is what confines white to the
  // middle of the blob instead of letting it spread across the whole face --
  // a gentle falloff whitens most of the visible disc, because a sphere seen
  // head-on presents a lot of near-camera-facing surface.
  float coreHot = pow(facing, 8.0);

  // Organic shimmer driven by the SAME noise value that displaces this
  // fragment, so bright patches track the shape's own bulges rather than
  // sliding around independently of it.
  float shimmer = 0.2 * clamp(vNoise, -1.0, 1.0);

  float intensity = body + coreHot * 2.6 + shimmer;

  vec3 col = mix(uColor, vec3(1.0), clamp(coreHot * 0.9, 0.0, 1.0));
  gl_FragColor = vec4(col * intensity, 1.0);
}
`;

const ringVertexShader = `
varying vec2 vLocal;

void main() {
  // RingGeometry is built in the XY plane, so the local xy IS the radial
  // coordinate the fragment shader needs. Billboard turns the whole thing to
  // face the camera, which is what keeps it reading as a circle from every
  // orbit angle instead of collapsing to an ellipse.
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ringFragmentShader = `
uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uTime;
uniform float uInner;
uniform float uOuter;
uniform float uSpeed;
varying vec2 vLocal;

void main() {
  float r = length(vLocal);
  float t = clamp((r - uInner) / max(uOuter - uInner, 1e-5), 0.0, 1.0);

  // The geometry is a WIDE annulus but the visible ring is a thin line drawn
  // inside it -- the surplus width is what gives the glow somewhere to fall
  // off into. A hard-edged thin annulus would alias badly at this scale.
  float band = pow(max(1.0 - abs(t - 0.5) * 2.0, 0.0), 3.0);

  // A slow sweep around the circumference, so the ring shifts between the
  // entity colour and a lighter tint rather than sitting as a flat circle.
  // Speed is tied to trust (see uSpeed); the tint itself is atmosphere.
  float angle = atan(vLocal.y, vLocal.x);
  float sweep = 0.5 + 0.5 * sin(angle - uTime * uSpeed);

  vec3 tint = mix(uColor, uAccent, 0.45 * sweep);
  float alpha = band * (0.35 + 0.65 * sweep);
  gl_FragColor = vec4(tint * (0.85 + 1.7 * sweep), alpha);
}
`;

/** Blob radius as a fraction of the ring radius. The reference sits near a
 *  quarter; going much larger is what made the first attempt read as a sphere
 *  in fog rather than a contained core. */
const CORE_TO_RING = 0.25;
/** Ring radius as a multiple of the node's base scale — matches the footprint
 *  the old aura layer occupied, so node spacing in the graph is unchanged. */
const RING_TO_BASE = 2.0;

export function AgentBlob({
  color,
  scale,
  trustScore,
}: {
  color: string;
  scale: number;
  /** 0-100. Drives core agitation and ring sweep speed — see the module doc
   *  comment for why this is tied to real data rather than decorative. */
  trustScore: number;
}) {
  const t = Math.max(0, Math.min(100, trustScore)) / 100;

  // Low trust -> a more agitated, less spherical core and a faster ring
  // sweep. High trust -> calmer and closer to round. Low FREQUENCY is what
  // keeps the shape a few broad lobes (a teardrop, like the reference) rather
  // than many small bumps.
  const amplitude = 0.22 - t * 0.1; // 0.22 .. 0.12
  const frequency = 1.6 - t * 0.5; // 1.6 .. 1.1
  const sweepSpeed = 0.9 - t * 0.45; // 0.9 .. 0.45

  const ringR = scale * RING_TO_BASE;
  const coreR = ringR * CORE_TO_RING;
  // The annulus is wider than the visible line; the shader draws the line at
  // its midpoint and fades outward from there.
  const ringInner = ringR * 0.8;
  const ringOuter = ringR * 1.2;

  // useState's lazy initializer, not useMemo and not a ref read during render.
  // Three constraints hold at once: the object must exist at RENDER time (it
  // is handed to <shaderMaterial uniforms={}>, which R3F reads once to build
  // the material), it must be MUTATED every frame afterward (replacing it
  // would make R3F treat it as a changed prop and recompile the shader
  // program instead of updating a float), and the setter is never called, so
  // React never re-renders because of it. A ref satisfies the second but not
  // the first — reading `.current` during render is what the refs lint rule
  // catches, and did catch on the GradientWaves fallback layer earlier.
  const [coreUniforms] = useState(() => ({
    uTime: { value: 0 },
    uAmplitude: { value: amplitude },
    uFrequency: { value: frequency },
    uColor: { value: new Color(color) },
  }));

  const [ringUniforms] = useState(() => ({
    uTime: { value: 0 },
    uInner: { value: ringInner },
    uOuter: { value: ringOuter },
    uSpeed: { value: sweepSpeed },
    uColor: { value: new Color(color) },
    // A lighter, cooler tint for the sweep to travel toward. Kept close to the
    // entity hue so the ring still reads as "agent" at a glance rather than
    // introducing a colour the legend doesn't explain.
    uAccent: { value: new Color("#bfe6ff") },
  }));

  useEffect(() => {
    coreUniforms.uColor.value.set(color);
    ringUniforms.uColor.value.set(color);
  }, [color, coreUniforms, ringUniforms]);

  // Mutating an existing uniform's `.value` per frame is three.js's own
  // documented contract for driving a shader (what drei's `shaderMaterial`
  // helper and the official R3F examples do), not accidental state mutation.
  // The rule below is tuned for React state/memo semantics and has no
  // exception for it; the restructuring it would accept — a fresh object each
  // frame — forces a shader rebuild every frame and is strictly worse. Block
  // disable rather than next-line: the directive has to bracket the mutating
  // statements themselves, not sit above `useFrame(`, or it silences nothing.
  useFrame(({ clock }) => {
    const elapsed = clock.getElapsedTime();
    /* eslint-disable react-hooks/immutability */
    coreUniforms.uTime.value = elapsed;
    coreUniforms.uAmplitude.value = amplitude;
    coreUniforms.uFrequency.value = frequency;
    ringUniforms.uTime.value = elapsed;
    ringUniforms.uInner.value = ringInner;
    ringUniforms.uOuter.value = ringOuter;
    ringUniforms.uSpeed.value = sweepSpeed;
    /* eslint-enable react-hooks/immutability */
  });

  return (
    <>
      {/* An invisible, generous hit target. The visible core is deliberately
          small now, and hovering a node is how the whole graph is inspected —
          shrinking the clickable area along with the art would be a real
          regression. Zero opacity rather than visible={false}, because
          three.js skips invisible objects during raycasting. */}
      <mesh scale={scale * 1.3}>
        <sphereGeometry args={[1, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <Billboard>
        <mesh>
          <ringGeometry args={[ringInner, ringOuter, 128]} />
          <shaderMaterial
            uniforms={ringUniforms}
            vertexShader={ringVertexShader}
            fragmentShader={ringFragmentShader}
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
          />
        </mesh>
      </Billboard>

      <mesh scale={coreR}>
        <sphereGeometry args={[1, 64, 64]} />
        <shaderMaterial uniforms={coreUniforms} vertexShader={coreVertexShader} fragmentShader={coreFragmentShader} />
      </mesh>
    </>
  );
}
