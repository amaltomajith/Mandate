import type { SupabaseClient } from "@supabase/supabase-js";

/** What every worker MCP server is built over: one merchant, one database handle.
 *  There is no parameter on any tool that names a merchant; the closure is the tenant. */
export interface McpContext {
  db: SupabaseClient;
  merchantId: string;
}

export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/** Paise to a rupee string. For model-facing text; never parsed back. */
export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
