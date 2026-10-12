import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { withLock } from "@/lib/mutex";

/**
 * The lock around the money path: enforce calls and approvals for one merchant
 * run one at a time, across every server instance.
 *
 * Two layers. The in-process mutex orders callers inside this process cheaply
 * (and means only one of them at a time asks the database). The database lease
 * (migration 0027) orders instances against each other. The lease expires on its
 * own, so a crashed holder cannot wedge a merchant: the TTL only has to outlast
 * one evaluation, including the network call that moves the money.
 */
const LEASE_SECONDS = 90;
const WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withMerchantLock<T>(merchantId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(merchantId, async () => {
    // The generated database types do not know these functions; the client is used untyped here.
    const db = createAdminClient() as unknown as SupabaseClient;
    const owner = randomUUID();
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const { data, error } = await db.rpc("acquire_merchant_lock", { p_merchant: merchantId, p_owner: owner, p_ttl_seconds: LEASE_SECONDS });
      if (error) throw new Error(`Could not take the merchant lock: ${error.message}`);
      if (data === true) break;
      if (Date.now() > deadline) throw new Error("Another request is still working on this account. Try again in a moment.");
      await sleep(50 + Math.random() * 100);
    }
    try {
      return await fn();
    } finally {
      await db.rpc("release_merchant_lock", { p_merchant: merchantId, p_owner: owner });
    }
  });
}
