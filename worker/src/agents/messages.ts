import { completeText } from "../lib/llm";

/**
 * The words the agents send. Every message has a plain template, so the loop
 * works with no language model at all. When a model is available it is asked to
 * make the message read like a person wrote it, and its output is only used if it
 * keeps every fact the template stated and invents none.
 */

export const money = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export interface Facts {
  /** Strings that must survive verbatim: names, quantities, prices, links. */
  required: string[];
}

/** Every ₹ amount appearing in `text`. */
function amountsIn(text: string): string[] {
  return [...text.matchAll(/₹\s*[\d,]+(?:\.\d+)?/g)].map((m) => m[0].replace(/\s/g, ""));
}

/**
 * A model's rewording of `template`, or the template itself.
 *
 * It is rejected unless it (a) still contains every required fact exactly and
 * (b) contains no rupee amount the template did not. Without (b), a model that
 * "helpfully" quotes a better price to a buyer would be making a commitment
 * nobody approved.
 */
export async function polish(template: string, facts: Facts, tone: string): Promise<string> {
  const rewritten = await completeText(
    "You rewrite short business messages so they read naturally and politely, like a real person wrote them. " +
      "Keep every fact, number, name, link and amount exactly as given. Do not add any new price, amount, date or promise. " +
      "Do not use markdown. Reply with the message text only.",
    `Tone: ${tone}\n\nMessage to rewrite:\n${template}`,
    0.5
  );
  if (!rewritten || rewritten.length > template.length * 3 + 200) return template;
  if (!facts.required.every((f) => rewritten.includes(f))) return template;
  const allowed = new Set(amountsIn(template));
  if (amountsIn(rewritten).some((a) => !allowed.has(a))) return template;
  return rewritten;
}

export function rfqMessage(p: { vendor: string; store: string; name: string; sku: string; qty: number }): { text: string; facts: Facts } {
  const text =
    `Hello ${p.vendor},\n\n` +
    `We would like a quote for ${p.qty} x ${p.name} (${p.sku}). Could you tell us your price per unit, ` +
    `your minimum order quantity, the delivery lead time, and how long the quote is valid?\n\n` +
    `Thank you,\n${p.store}`;
  return { text, facts: { required: [p.name, String(p.qty)] } };
}

export function voiceConfirmMessage(p: { vendor: string; store: string; name: string; unitPaise: number; moq: number }): { text: string; facts: Facts } {
  const text =
    `Hello ${p.vendor},\n\n` +
    `Thank you for your voice note. So that it is on record, this is what we understood: ${p.name} at ${money(p.unitPaise)} per unit, minimum order ${p.moq}. ` +
    `Please reply YES in writing if that is correct, or send the correct details.\n\nThank you,\n${p.store}`;
  return { text, facts: { required: [p.name, money(p.unitPaise), String(p.moq)] } };
}

export function poConfirmationMessage(p: {
  vendor: string;
  store: string;
  name: string;
  sku: string;
  qty: number;
  unitPaise: number;
  totalPaise: number;
  advancePaise: number;
  ref: string;
}): { text: string; facts: Facts } {
  const text =
    `Hello ${p.vendor},\n\n` +
    `We are confirming our order of ${p.qty} x ${p.name} (${p.sku}) at ${money(p.unitPaise)} per unit, ` +
    `${money(p.totalPaise)} in total. We have paid an advance of ${money(p.advancePaise)} (reference ${p.ref}). ` +
    `Please confirm the dispatch date.\n\nThank you,\n${p.store}`;
  return { text, facts: { required: [p.name, String(p.qty), money(p.unitPaise), money(p.totalPaise), money(p.advancePaise), p.ref] } };
}

export function clearanceOfferMessage(p: { customer: string; store: string; name: string; pricePaise: number; originalPaise: number }): { text: string; facts: Facts } {
  const text =
    `Hi ${p.customer}, ${p.name} is now ${money(p.pricePaise)} (it was ${money(p.originalPaise)}) for a short time. ` +
    `Reply if you would like one, or tell us what price works for you.\n\n${p.store}`;
  return { text, facts: { required: [p.name, money(p.pricePaise), money(p.originalPaise)] } };
}

export function counterMessage(p: { customer: string; store: string; name: string; counterPaise: number }): { text: string; facts: Facts } {
  const text = `Hi ${p.customer}, thanks for the offer. The best we can do on ${p.name} is ${money(p.counterPaise)} each. Would that work for you?\n\n${p.store}`;
  return { text, facts: { required: [p.name, money(p.counterPaise)] } };
}

export function acceptWithLinkMessage(p: { customer: string; store: string; name: string; qty: number; pricePaise: number; link: string }): { text: string; facts: Facts } {
  const text =
    `Hi ${p.customer}, great, we have a deal: ${p.qty} x ${p.name} at ${money(p.pricePaise)} each. ` +
    `You can pay securely here: ${p.link}\n\nThank you,\n${p.store}`;
  return { text, facts: { required: [p.name, money(p.pricePaise), p.link] } };
}

export function declineMessage(p: { customer: string; store: string; name: string }): { text: string; facts: Facts } {
  const text = `Hi ${p.customer}, thank you for the interest. Unfortunately we cannot go that low on ${p.name}, but the offer at our current price stays open.\n\n${p.store}`;
  return { text, facts: { required: [p.name] } };
}

export function holdMessage(p: { customer: string; store: string }): { text: string; facts: Facts } {
  const text = `Hi ${p.customer}, thank you. We are confirming this with the team and will come back to you shortly.\n\n${p.store}`;
  return { text, facts: { required: [] } };
}
