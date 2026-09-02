import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Remembers which nonces have been used, so a captured request cannot be
 * replayed inside the skew window.
 *
 * Uniqueness is enforced by the primary key rather than by a read-then-write.
 * Two concurrent replays would both pass a check, and a replay racing its own
 * original is exactly the shape an attacker would aim for -- so the insert
 * itself is the check, and the database resolves it atomically no matter how
 * many instances are serving.
 */

/** Postgres unique-violation. Anything else is a real failure. */
const UNIQUE_VIOLATION = "23505";

export async function recordNonce(nonce: string, keyid: string, expiresAt: Date): Promise<boolean> {
  const db = createAdminClient();

  const { error } = await db.from("seen_nonces").insert({
    nonce,
    agent_id: keyid,
    expires_at: expiresAt.toISOString(),
  });

  if (!error) {
    // Opportunistic pruning, on the way past. A row is only meaningful for as
    // long as the skew window, so this needs no scheduler -- and a scheduler is
    // a thing that can be absent, which is worse than a sweep that occasionally
    // does not run.
    if (Math.random() < 0.02) {
      await db.from("seen_nonces").delete().lt("expires_at", new Date().toISOString());
    }
    return true;
  }

  if (error.code === UNIQUE_VIOLATION) return false;

  // Fails CLOSED. An unavailable store means replays cannot be detected, and
  // the safe reading of "I cannot tell whether this is a replay" on a money
  // action is to refuse it. The alternative -- letting it through -- turns a
  // database blip into an open replay window.
  throw new Error(`Replay check unavailable: ${error.message}`);
}
