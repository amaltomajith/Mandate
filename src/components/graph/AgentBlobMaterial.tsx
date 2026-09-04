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
 * `GradientWaves` hero is a raymarched fragment shader; these are field
 * shaders, same house style, inside the entity graph's own three.js scene.
 *
 * STRUCTURE. A thin ring with a soft, slowly rippling core floating at its
 * centre and dark space between the two. BOTH are flat billboarded fields, not
 * lit geometry, and that is the load-bearing decision: two earlier attempts
 * built the core as a shaded sphere and neither could get there, because a
 * solid mesh ends at its silhouette. On screen that read as a flat, hard-edged
 * opaque polygon — no glow, no soft edge, nothing to bloom. The reference's
 * core has no silhouette at all; it fades out into the dark.
 *
 * COLOUR comes from the construction rather than being painted on. The core
 * evaluates the same blob field twice, offset slightly in opposite directions,
 * once in each hue; overlapping, they sum past white, and where only one
 * reaches, its hue shows as a fringe. The ring runs the same two hues around
 * its circumference. See the core shader for why that also survives tone
 * mapping when a hand-painted white centre did not.
 *
 * The noise function is the standard Ashima Arts 3D simplex noise (MIT/public
 * domain, what nearly every GLSL blob/terrain/cloud effect on the web is built
 * on) — inlined as a template literal, matching how GradientWaves.tsx inlines
 * its own fragment shader rather than adding a shader-chunk dependency.
 *
 * RIPPLE AMPLITUDE AND SPEED ARE TIED TO TRUST, not arbitrary: a calmer,
 * rounder, slower core for a high-trust agent, a more agitated one for a
 * low-trust agent. That is a real mapping from this app's own data, the same
 * discipline the rest of the scene follows (colour by entity type, size by
 * trust), rather than motion added for spectacle.
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
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The core is a SOFT FIELD on a billboarded quad, not a shaded sphere.
 *
 * A lit sphere was the wrong model and no amount of tuning its shading was
 * going to get there: in the app it rendered as a flat, hard-edged opaque
 * polygon, because a solid mesh terminates at its silhouette. The reference's
 * core has no silhouette at all -- it is a glowing mass that fades out into
 * the dark, white in the middle with a magenta fringe on one side and a cyan
 * fringe on the other.
 *
 * Those fringes are the giveaway that it is two overlapping fields rather than
 * one shaded object, and that is exactly how this reproduces it: the same blob
 * is evaluated twice, offset slightly in opposite directions, once per hue.
 * Where the two overlap their colours sum past white; where only one reaches,
 * its own hue shows as a fringe. The white centre therefore falls out of the
 * construction instead of being painted on -- which also makes it robust to
 * tone mapping, since both contributing channels are already high.
 */
const coreFragmentShader = `
uniform float uTime;
uniform float uAmplitude;
uniform float uSpeed;
uniform vec3 uColor;
uniform vec3 uAccent;
varying vec2 vUv;

${SIMPLEX_NOISE_GLSL}

// Signed distance to a wobbling blob: negative inside, zero at the edge.
// Two noise octaves at different scales and speeds, so the surface rolls and
// folds rather than pulsing uniformly -- the "thinking" motion is mostly this,
// a slow low-frequency drift with a smaller one running across it.
float blobField(vec2 p, float t, float amp) {
  float n1 = snoise(vec3(p * 1.35, t));
  float n2 = snoise(vec3(p * 3.0 + 11.0, t * 0.75));
  float wobble = amp * (n1 * 0.7 + n2 * 0.25);
  return length(p) - (0.42 + wobble);
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float t = uTime * uSpeed;

  vec2 off = vec2(0.055, -0.045);
  float dA = blobField(p - off, t, uAmplitude);
  float dB = blobField(p + off, t, uAmplitude);

  // Soft edges. The falloff width is the whole difference between a glowing
  // mass and the cutout this used to render as.
  float mA = smoothstep(0.10, -0.14, dA);
  float mB = smoothstep(0.10, -0.14, dB);

  // A faint halo so the blob sits in its own light instead of ending abruptly
  // where the field does. Kept deliberately tight and weak: the dark gap
  // between core and ring is part of the composition, and a generous halo
  // fills it with grey wash and closes the gap up.
  float halo = smoothstep(0.30, -0.05, min(dA, dB)) * 0.2;

  vec3 col = uColor * mA + uAccent * mB + (uColor + uAccent) * 0.5 * halo;

  // Additive over black, so the quad's corners contribute nothing and only
  // the field is visible -- no quad edge, no alpha-sorting against the ring.
  gl_FragColor = vec4(col * 1.35, 1.0);
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
  //
  // Exponent raised from 3 after seeing it in the app: bloom widens whatever
  // it is given, so a line that looked right in an unbloomed render came out
  // as a fat soft tube on screen. Drawing it tighter than it should finally
  // look leaves bloom room to do its half of the work.
  float band = pow(max(1.0 - abs(t - 0.5) * 2.0, 0.0), 5.0);

  float angle = atan(vLocal.y, vLocal.x);

  // HUE and BRIGHTNESS sweep on DIFFERENT phases, and that separation is the
  // point. Driving both from one value tied the ring's brightest arc to its
  // most-accented arc, and since the bright end ran well past 1.0 it clipped
  // to flat white -- so the ring showed magenta fading to white rather than
  // magenta to cyan. Same failure as the core's, in a different place.
  float hueSweep = 0.5 + 0.5 * sin(angle - uTime * uSpeed);
  float lum = 0.75 + 0.5 * (0.5 + 0.5 * sin(angle - uTime * uSpeed + 1.2));

  // Full-range mix, so each side of the ring reaches its actual colour
  // instead of a washed blend of the two.
  vec3 tint = mix(uColor, uAccent, hueSweep);
  float alpha = band * (0.45 + 0.55 * lum);
  gl_FragColor = vec4(tint * lum, alpha);
}
`;

/**
 * The colour the ring's sweep travels toward, away from the agent hue — the
 * reference's ring runs cyan on one side to magenta on the other, and that
 * two-tone shift is most of what stops it reading as a flat drawn circle.
 *
 * Nudged off the escalation palette's "approved" cyan (#22d3ee) rather than
 * reusing it: that hue carries a meaning elsewhere in this same scene, and a
 * gradient stop on an agent's ring is not that meaning.
 */
const RING_SWEEP_ACCENT = "#3ee0ff";

/** Blob radius as a fraction of the ring radius. The reference sits near a
 *  quarter; going much larger is what made the first attempt read as a sphere
 *  in fog rather than a contained core. */
const CORE_TO_RING = 0.4;
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

  // Low trust -> a more agitated core that rolls faster. High trust -> a
  // calmer, rounder one. Both stay slow in absolute terms: the motion should
  // read as something thinking, not something straining.
  const amplitude = 0.17 - t * 0.07; // 0.17 .. 0.10
  const rippleSpeed = 0.55 - t * 0.25; // 0.55 .. 0.30
  // The ring's gradient drifts rather than spins — fast enough to be alive on
  // a second look, slow enough not to pull the eye off the panels.
  const sweepSpeed = 0.18 - t * 0.08; // 0.18 .. 0.10

  const ringR = scale * RING_TO_BASE;
  // The quad is wider than the blob so the field has room to fade out inside
  // it; blobField's base radius (0.42 of half-extent) lands the visible blob
  // back at CORE_TO_RING.
  const coreQuad = ringR * (CORE_TO_RING / 0.42) * 2.0;
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
    uSpeed: { value: rippleSpeed },
    uColor: { value: new Color(color) },
    uAccent: { value: new Color(RING_SWEEP_ACCENT) },
  }));

  const [ringUniforms] = useState(() => ({
    uTime: { value: 0 },
    uInner: { value: ringInner },
    uOuter: { value: ringOuter },
    uSpeed: { value: sweepSpeed },
    uColor: { value: new Color(color) },
    uAccent: { value: new Color(RING_SWEEP_ACCENT) },
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
    coreUniforms.uSpeed.value = rippleSpeed;
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

      {/* Ring and core share one Billboard: both are flat fields, and the
          reference's look depends on seeing them face-on. Turning them
          together also keeps the core centred in the ring from every orbit
          angle, which two independent billboards would not guarantee. */}
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

        <mesh>
          <planeGeometry args={[coreQuad, coreQuad]} />
          <shaderMaterial
            uniforms={coreUniforms}
            vertexShader={coreVertexShader}
            fragmentShader={coreFragmentShader}
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
          />
        </mesh>
      </Billboard>
    </>
  );
}
