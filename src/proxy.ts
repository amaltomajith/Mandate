import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Dashboard (human) auth is Clerk — unrelated to the Web Bot Auth verification
 * the MCP route does for agents; see HANDOVER.md "two auth layers". `/api/mcp`
 * and `/api/wba-directory` are excluded here because they authenticate
 * themselves (Ed25519 request signatures / public data) and were never Clerk's
 * job to gate.
 *
 * Named `proxy.ts` per Next.js 16 (the file used to be `middleware.ts` —
 * renamed upstream, not a Mandate-specific choice).
 */
const isPublicRoute = createRouteMatcher([
  "/login(.*)",
  "/sign-up(.*)",
  "/api/mcp",
  "/api/wba-directory",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
