import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login"];

/**
 * Session refresh + route protection for the merchant dashboard. This is
 * Supabase Auth (the human/merchant login) — unrelated to the Web Bot Auth
 * verification the MCP route does for agents; see HANDOVER.md "two auth layers".
 *
 * Named `proxy.ts` per Next.js 16 (the file used to be `middleware.ts` — renamed
 * upstream, not a Mandate-specific choice; see node_modules/next's own docs).
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return response;

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PATHS.some((p) => request.nextUrl.pathname.startsWith(p));
  const isApiOrAsset =
    request.nextUrl.pathname.startsWith("/api") || request.nextUrl.pathname.startsWith("/_next");

  if (!user && !isPublic && !isApiOrAsset) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/mcp|api/wba-directory).*)"],
};
