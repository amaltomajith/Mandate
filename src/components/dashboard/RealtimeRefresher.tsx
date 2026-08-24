"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

const LIVE_TABLES = ["traces", "escalations", "alerts", "agents", "policy_rules"] as const;

/** Keeps the dashboard live: any change to the tables the graph/panels render
 *  triggers a server-component refresh, no polling loop needed. */
export function RealtimeRefresher() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let channel = supabase.channel("dashboard-live");
    for (const table of LIVE_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => router.refresh()
      );
    }
    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
