"use client";

import { useState } from "react";
import { AddEquation, Color, CustomBlending, OneFactor } from "three";

/**
 * A fresnel glow shell — the material for the outer layer of the scene's solid
 * nodes (rules, mandates), replacing the flat translucent shells they used to
 * wear.
 *
 * The difference is where the light sits. A uniformly translucent copy of the
 * geometry is equally bright facing the camera and at its silhouette, which is
 * not how anything luminous behaves; it reads as a plastic shell around the
 * solid. Weighting the brightness toward grazing angles instead puts the light
 * on the rim, so the node reads as glowing rather than coated — the same
 * quality the agent node gets from its ring, arrived at for a solid.
 *
 * Deliberately NOT unifying the node hues or shapes. Colour and silhouette are
 * how the legend distinguishes an agent from a rule from an action, and
 * colors.ts records that folding them into one palette once made the whole
 * scene monochrome. This lifts how they are lit, not what they are.
 *
 * Nothing here animates, so the uniforms object is only ever read — which is
 * why this can pass uniforms as a prop, unlike the animated materials in this
 * folder that have to write through a ref.
 */

const vertexShader = `
varying vec3 vNormal;
varying vec3 vWorldPosition;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const fragmentShader = `
uniform vec3 uColor;
uniform float uPower;
uniform float uStrength;

varying vec3 vNormal;
varying vec3 vWorldPosition;

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), viewDir), 0.0, 1.0), uPower);
  float intensity = fresnel * uStrength;

  // Alpha carries coverage only; the material blends One/One so it never
  // scales the colour. A constant 1.0 would stamp the shell's whole silhouette
  // opaque over the starfield even where it contributes no light.
  gl_FragColor = vec4(uColor * intensity, clamp(intensity, 0.0, 1.0));
}
`;

export function GlowShellMaterial({
  color,
  /** Higher values pull the glow tighter to the silhouette. */
  power = 2.4,
  strength = 1.0,
}: {
  color: string;
  power?: number;
  strength?: number;
}) {
  const [uniforms] = useState(() => ({
    uColor: { value: new Color(color) },
    uPower: { value: power },
    uStrength: { value: strength },
  }));

  return (
    <shaderMaterial
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
  );
}
