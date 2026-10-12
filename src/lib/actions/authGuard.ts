import "server-only";
import { currentUser } from "@clerk/nextjs/server";
import { allowDashboardAction } from "@/lib/rateLimit";

/** Dashboard (human) auth is Clerk — see HANDOVER.md "two auth layers". */
export async function requireDashboardUser() {
  const user = await currentUser();
  if (!user) throw new Error("Not authenticated.");
  if (!allowDashboardAction(user.id)) throw new Error("Too many requests. Wait a moment and try again.");
  return {
    id: user.id,
    email: user.emailAddresses[0]?.emailAddress ?? user.id,
  };
}
