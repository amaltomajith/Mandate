import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel, MerchantSettings } from "@/types/db";
import type { ChannelDriver } from "./types";
import { SandboxDriver } from "./sandbox";
import { GmailDriver, loadGmailCredentials } from "./gmail";
import { WhatsAppDriver, ensureWhatsApp } from "./whatsapp";

/**
 * The channels available to one merchant right now.
 *
 * The sandbox is always there: it is how simulated contacts are answered. Real
 * channels exist only when the merchant is in LIVE mode AND has connected them,
 * so a merchant who has not gone live cannot message anyone real, whatever an
 * agent asks for.
 */
export async function buildDrivers(
  db: SupabaseClient,
  merchantId: string,
  settings: MerchantSettings
): Promise<Map<Channel, ChannelDriver>> {
  const drivers = new Map<Channel, ChannelDriver>();
  drivers.set("sandbox", new SandboxDriver());
  if (settings.channel_mode !== "live") return drivers;

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    const creds = await loadGmailCredentials(db, merchantId);
    if (creds) drivers.set("email", new GmailDriver(creds));
  }
  if (settings.whatsapp_enabled) drivers.set("whatsapp", new WhatsAppDriver(ensureWhatsApp(db, merchantId)));
  return drivers;
}
