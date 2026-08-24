import { useId } from "react";

export function MandateMark({ size = 26 }: { size?: number }) {
  // useId gives a stable, SSR-safe unique id per mounted instance — a module-level
  // counter would drift between server and client renders and trip hydration.
  const gradientId = `mandateMark-${useId()}`;

  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0d94fb" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${gradientId})`} />
      <circle cx="16" cy="16" r="6.5" fill="white" opacity="0.92" />
      <circle cx="16" cy="16" r="10.5" stroke="white" strokeWidth="1.2" opacity="0.4" />
    </svg>
  );
}
