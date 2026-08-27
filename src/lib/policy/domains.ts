import type { PolicyDomain } from "@/types/db";

/**
 * Policy domains — merchant-defined, not hardcoded. Instead of one global
 * rule set applying identically to every action, a merchant can create any
 * number of domains ("Purchases," "Recurring Mandates," "Logistics,"
 * whatever their business actually has), each independently governed: its
 * own policy rules, its own human-approval queue, its own agents. Domains
 * are real rows in `policy_domains` (src/lib/actions/domains.ts has the
 * CRUD), positioned and dragged on the canvas in
 * src/components/dashboard/PolicyDomainsCanvas.tsx.
 *
 * Routing is content-based, computed at evaluation time from the two
 * signals every action already carries — no new schema needed on traces or
 * agents: an action belongs to a domain if its action type is in that
 * domain's `match_action_types`, or its category is in `match_categories`.
 * Exactly one domain is flagged `is_default` (the seeded "General" domain)
 * and catches anything nothing else claims — every action always resolves
 * to *some* domain, never falls through ungoverned.
 */

export function matchesDomain(actionType: string, category: string | null | undefined, domain: PolicyDomain): boolean {
  if (domain.match_action_types.includes(actionType)) return true;
  if (category && domain.match_categories.includes(category)) return true;
  return false;
}

/** First non-default domain whose routing rules match wins; falls back to
 *  whichever domain is flagged `is_default`. Returns null only if the
 *  domain list itself is empty (nothing seeded yet) — callers should treat
 *  that as "policy engine has nothing configured," not silently allow. */
export function resolveDomain(
  actionType: string,
  category: string | null | undefined,
  domains: PolicyDomain[]
): PolicyDomain | null {
  const specific = domains.find((d) => !d.is_default && matchesDomain(actionType, category, d));
  if (specific) return specific;
  return domains.find((d) => d.is_default) ?? domains[0] ?? null;
}
