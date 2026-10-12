"use client";

import { SignOutButton as ClerkSignOutButton } from "@clerk/nextjs";

export function SignOutButton() {
  return (
    <ClerkSignOutButton redirectUrl="/login">
      <button type="button" className="focus-ring inline-flex min-h-[44px] items-center rounded-[12px] px-2 text-[15px] font-medium transition-colors hover:text-white" style={{ color: "var(--muted)" }}>
        Sign out
      </button>
    </ClerkSignOutButton>
  );
}
