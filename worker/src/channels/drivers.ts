import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel, MerchantSettings } from "@/types/db";
import type { ChannelDriver } from "./types";
import { SandboxDriver } from "./sandbox";

/**
 * The channels available to one merchant right now. The sandbox is always there
 * (it is how simulated contacts are answered). Real channels exist only when the
 * merchant is in live mode AND has connected them; see gmail.ts and whatsapp.ts.
 */
export async function buildDrivers(
  _db: SupabaseClient,
  _merchantId: string,
  _settings: MerchantSettings
): Promise<Map<Channel, ChannelDriver>> {
  const drivers = new Map<Channel, ChannelDriver>();
  drivers.set("sandbox", new SandboxDriver());
  return drivers;
}
