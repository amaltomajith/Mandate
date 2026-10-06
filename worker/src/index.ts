import "./env";
import { createAdminClient } from "@/lib/supabase/admin";

async function main() {
  const db = createAdminClient();
  const { error, count } = await db.from("merchants").select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  console.log(`[worker] up. merchants visible: ${count}`);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
