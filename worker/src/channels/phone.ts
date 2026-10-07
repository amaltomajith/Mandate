/**
 * One canonical form for a phone number, so "+91 98765 43210", "9876543210" and a
 * WhatsApp id all compare equal. Digits only, with India's country code assumed
 * for a bare ten-digit number (the product is for Indian merchants).
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}

/** A WhatsApp user id for a phone number. */
export function toJid(phone: string): string {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

/** The phone number inside a WhatsApp user id, or null for groups, broadcasts and the like. */
export function fromJid(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
  return jid.split("@")[0].split(":")[0];
}
