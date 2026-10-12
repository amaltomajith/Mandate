import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMerchant } from "@/lib/merchant";
import { allow } from "@/lib/rateLimit";
import { buildGstExport } from "@/lib/gst";

/**
 * GST registers as CSV: ?kind=sales|purchases&from=YYYY-MM-DD&to=YYYY-MM-DD, in
 * India time. Behind Clerk like the rest of the dashboard and scoped to the
 * signed-in merchant; the basis of the figures is stated in src/lib/gst.ts.
 */
export async function GET(req: Request) {
  const merchant = await getCurrentMerchant();
  if (!allow(`export-gst:${merchant.id}`, 10, 60_000)) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "30" } });
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  if (kind !== "sales" && kind !== "purchases") return NextResponse.json({ error: "kind must be sales or purchases" }, { status: 400 });
  try {
    const r = await buildGstExport(createAdminClient() as never, merchant.id, kind, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    return new NextResponse(r.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mandate-gst-${kind}-${from}-to-${to}.csv"`,
        "cache-control": "no-store",
        "x-rows": String(r.summary.rows),
        "x-missing-rate": String(r.summary.missingRate),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not build that export." }, { status: 400 });
  }
}
