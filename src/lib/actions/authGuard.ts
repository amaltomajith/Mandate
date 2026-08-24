import "server-only";
import { currentUser } from "@clerk/nextjs/server";

/** Dashboard (human) auth is Clerk — see HANDOVER.md "two auth layers". */
export async function requireDashboardUser() {
  const user = await currentUser();
  if (!user) throw new Error("Not authenticated.");
  return {
    id: user.id,
    email: user.emailAddresses[0]?.emailAddress ?? user.id,
  };
}
