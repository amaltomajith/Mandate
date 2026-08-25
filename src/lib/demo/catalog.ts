// A small, deliberately simple product catalog + cross-sell pairing map, so
// the demo agent reads as agentic *commerce* (an AI buyer deciding what to
// purchase and proposing a complementary add-on) rather than just a script
// that fires fixed-amount actions to exercise the policy engine. This is what
// closes the gap with Track 01's actual ask ("build an agent that grows
// revenue... or makes a merchant transactable by an AI buyer") — the policy
// gating underneath is unchanged, this only changes what the agent is shown
// deciding to buy and why.

export interface CatalogItem {
  sku: string;
  name: string;
  priceInPaise: number;
  category: string;
}

export const CATALOG: CatalogItem[] = [
  { sku: "mouse-01", name: "Wireless Mouse", priceInPaise: 89900, category: "electronics" },
  { sku: "keyboard-01", name: "Mechanical Keyboard", priceInPaise: 449900, category: "electronics" },
  { sku: "stand-01", name: "Laptop Stand", priceInPaise: 219900, category: "office" },
  { sku: "hub-01", name: "USB-C Hub", priceInPaise: 129900, category: "electronics" },
  { sku: "desk-01", name: "Premium Standing Desk", priceInPaise: 699900, category: "office" },
];

/** sku -> the sku it's a natural cross-sell pair for, plus the pitch the agent uses. */
export const UPSELL_PAIRS: Record<string, { pairsWithSku: string; pitch: string }> = {
  "mouse-01": { pairsWithSku: "keyboard-01", pitch: "customers who buy this mouse usually complete the desk with this keyboard" },
  "stand-01": { pairsWithSku: "hub-01", pitch: "a laptop stand plus a USB-C hub is the standard combo for this setup" },
};

export function findItem(sku: string): CatalogItem {
  const item = CATALOG.find((i) => i.sku === sku);
  if (!item) throw new Error(`Unknown catalog sku: ${sku}`);
  return item;
}
