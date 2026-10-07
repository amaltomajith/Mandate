import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMerchant } from "@/lib/merchant";
import { verifyState } from "@/lib/oauthState";
import { encryptJson } from "@/lib/secrets";

/**
 * Google sends the merchant back here with a one-time code. The code is only
 * exchanged after the signed state and the browser cookie both check out, and
 * the result is stored encrypted: the refresh token never reaches the browser.
 */
export async function GET(req: NextRequest) {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const back = (status: string) => NextResponse.redirect(`${appUrl}/dashboard?gmail=${status}`);

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (req.nextUrl.searchParams.get("error") || !code || !state) return back("denied");

  const merchant = await getCurrentMerchant();
  if (!verifyState(state, merchant.id, req.cookies.get("mandate_gmail_nonce")?.value)) return back("invalid_state");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: `${appUrl}/api/connections/gmail/callback`,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokens = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
  if (!tokenRes.ok || !tokens.access_token) return back("token_failed");
  if (!tokens.refresh_token) return back("no_refresh_token");

  const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const { emailAddress } = (await profile.json().catch(() => ({}))) as { emailAddress?: string };
  if (!emailAddress) return back("profile_failed");

  const { error } = await createAdminClient()
    .from("connections")
    .upsert(
      {
        merchant_id: merchant.id,
        kind: "gmail",
        status: "connected",
        account_label: emailAddress,
        secret_enc: encryptJson({ refresh_token: tokens.refresh_token, email: emailAddress }),
        meta: {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "merchant_id,kind" }
    );
  if (error) return back("save_failed");

  const res = back("connected");
  res.cookies.delete({ name: "mandate_gmail_nonce", path: "/api/connections/gmail" });
  return res;
}
