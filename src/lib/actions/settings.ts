"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMerchant } from "@/lib/merchant";
import { countResettableRows, resetTransactionsFor, resetEverythingFor, type ResetCounts } from "@/lib/reset";

/**
 * The account controls behind /dashboard/settings.
 *
 * THE TENANT IS NEVER AN ARGUMENT. Every function here resolves the merchant
 * through `getCurrentMerchant()`, which reads the Clerk session and throws when
 * nobody is signed in. No exported function takes a merchant id, slug or scope,
 * so there is no shape of client call that can aim a delete at another tenant —
 * the same rule every other mutation in this app follows, and the last place it
 * should be relaxed is the one page that only does destructive things.
 *
 * `resetEverything` does take a typed slug, and it is worth being precise about
 * what that is for: it is compared against the session merchant's own slug and
 * then discarded. It never selects anything. Passing another merchant's slug
 * does not reach that merchant — it just fails the check.
 */

export interface ResetPreview extends ResetCounts {
  merchantName: string;
  merchantSlug: string;
}

/**
 * Counts, before anything is deleted.
 *
 * The confirm dialog needs real numbers rather than a generic warning, and the
 * brief for this page was explicit that it must not delete blind: this runs on
 * open and again immediately before either confirm, so the figure someone
 * agrees to is the figure that goes.
 */
export async function previewReset(): Promise<ResetPreview> {
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const counts = await countResettableRows(db, merchant.id);
  return { ...counts, merchantName: merchant.name, merchantSlug: merchant.slug };
}

/** Clears history for the signed-in merchant. Agents and their keys survive. */
export async function resetTransactions(): Promise<ResetCounts> {
  const merchant = await getCurrentMerchant();
  const db = createAdminClient();
  const deleted = await resetTransactionsFor(db, merchant.id);
  revalidatePath("/dashboard");
  return deleted;
}

/**
 * Full reset for the signed-in merchant.
 *
 * `typedSlug` is a confirmation, not a selector — see the note at the top of
 * this file. Compared case-insensitively and trimmed, because the failure this
 * guards against is an accidental click, not a determined attacker who is,
 * after all, already signed in as the owner of the data.
 */
export async function resetEverything(typedSlug: string): Promise<ResetCounts> {
  const merchant = await getCurrentMerchant();

  if (typedSlug.trim().toLowerCase() !== merchant.slug.toLowerCase()) {
    throw new Error(
      `That does not match. Type "${merchant.slug}" exactly to confirm you mean to reset this account.`
    );
  }

  const db = createAdminClient();
  const deleted = await resetEverythingFor(db, merchant.id);
  revalidatePath("/dashboard");
  return deleted;
}
