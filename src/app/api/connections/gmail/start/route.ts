import { NextResponse } from "next/server";
import { getCurrentMerchant } from "@/lib/merchant";
import { createState } from "@/lib/oauthState";

/**
 * Begins connecting Gmail: sends the signed-in merchant to Google's consent
 * screen. Behind Clerk like the rest of the dashboard (it is not on the public
 * allow-list), so it only ever acts for a signed-in merchant.
 */
export async function GET() {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) return NextResponse.redirect(`${appUrl}/dashboard?gmail=not_configured`);

  const merchant = await getCurrentMerchant();
  const { state, nonce } = createState(merchant.id);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${appUrl}/api/connections/gmail/callback`,
    response_type: "code",
    // Read replies and send mail. Nothing else: no deleting, no settings, no contacts.
    scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    // Forces a refresh token even if this Google account connected before.
    prompt: "consent",
    state,
  }).toString();

  const res = NextResponse.redirect(url);
  res.cookies.set("mandate_gmail_nonce", nonce, { httpOnly: true, sameSite: "lax", secure: appUrl.startsWith("https"), maxAge: 600, path: "/api/connections/gmail" });
  return res;
}
