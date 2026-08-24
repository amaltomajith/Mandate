"use client";

import { SignOutButton as ClerkSignOutButton } from "@clerk/nextjs";

export function SignOutButton() {
  return (
    <ClerkSignOutButton redirectUrl="/login">
      <button className="text-xs font-medium hover:underline" style={{ color: "var(--muted)" }}>
        Sign out
      </button>
    </ClerkSignOutButton>
  );
}
