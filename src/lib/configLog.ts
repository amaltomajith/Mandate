import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A record of who changed which setting. The settings here decide how much the
 * agents may spend and whether they may act at all, so "who switched the team
 * off, and when" has to be answerable after the fact.
 */
export interface ConfigChange {
  field: string;
  from: string | null;
  to: string | null;
}

const show = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The fields whose value differs between two snapshots, as readable strings. */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]): ConfigChange[] {
  return fields.filter((f) => show(before[f]) !== show(after[f])).map((f) => ({ field: f, from: show(before[f]), to: show(after[f]) }));
}

/** Writes one row per change. Never throws into the action that made the change: a
 *  failure to log must not undo or block the setting, but it is reported. */
export async function logConfigChange(db: SupabaseClient, merchantId: string, actor: string, changes: ConfigChange[]): Promise<void> {
  if (changes.length === 0) return;
  const { error } = await db.from("config_events").insert(changes.map((c) => ({ merchant_id: merchantId, actor, field: c.field, old_value: c.from, new_value: c.to })));
  if (error) console.error("[config] could not record a settings change:", error.message);
}
