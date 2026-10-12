"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 5000;

/**
 * Keeps the dashboard fresh with a short poll instead of a client-side Supabase
 * Realtime subscription. That's a deliberate consequence of moving human auth to
 * Clerk: Realtime in the browser would authenticate as Supabase's `anon` role
 * (no Supabase session exists anymore), and this schema's RLS only grants reads
 * to `authenticated`. Opening `anon` SELECT policies just to keep Realtime working
 * would make the tables readable to anyone holding the (public, bundled) anon
 * key, bypassing Clerk's gate entirely — a worse tradeoff than a 4s poll. See
 * HANDOVER.md "auth".
 */
export function LiveRefresher() {
  const router = useRouter();

  useEffect(() => {
    // Refresh only while the tab is visible: a hidden tab re-runs every server
    // query (and a Clerk lookup) for nobody. Coming back refreshes at once.
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const interval = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);

  return null;
}
