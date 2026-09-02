import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Dashboard (human) auth is Clerk — unrelated to the Web Bot Auth verification
 * the MCP route does for agents; see HANDOVER.md "two auth layers". Everything under
 * `/api/m/<slug>/` is excluded here because it authenticates itself (Ed25519
 * request signatures) or is public by design (the machine-readable storefront
 * and the key directory). Discovery has to come before the signature: an agent
 * that cannot read the catalog until it holds credentials is one that can
 * never become a buyer.
 * `/architecture.html` is public documentation — gating it behind
 * a sign-in would defeat the point of linking it from the sign-in page, and
 * `/` is the landing page for the same reason: someone evaluating this should
 * be able to read what it is without first creating an account.
 *
 * Named `proxy.ts` per Next.js 16 (the file used to be `middleware.ts` —
 * renamed upstream, not a Mandate-specific choice).
 */
const isPublicRoute = createRouteMatcher([
  // Exactly the root, not "/(.*)" -- that would match every path in the app and
  // turn this allowlist into a no-op.
  "/",
  "/login(.*)",
  "/sign-up(.*)",
  // The whole per-merchant public surface: mcp, catalog, wba-directory. Each
  // path carries the merchant slug, and each authenticates itself or is public
  // by design. This is one pattern rather than three literals because the
  // three routes moved under /api/m/<slug>/ together, and listing them
  // individually is how the allowlist silently fell out of step with the
  // routes when they moved -- every one of them started redirecting to a
  // sign-in page that an AI buyer has no way to complete.
  "/api/m/(.*)",
  "/architecture.html",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
