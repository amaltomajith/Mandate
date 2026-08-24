"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 4000;

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
    const interval = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, [router]);

  return null;
}
