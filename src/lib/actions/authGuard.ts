import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function requireDashboardUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");
  return user;
}
