import { config } from "./config.js";
import { fetchStorefront, type CatalogItem, type Storefront } from "./catalog.js";
import { chooseWhatToBuy, decideOnOffer } from "./brain.js";
import { MerchantRejected, SignedMcpClient, type InputRequestSpec } from "./transport.js";
import { say, money, rule, indent } from "./log.js";

/**
 * The loop: decide, check, buy, answer the merchant, report.
 *
 * The shape worth noticing is that this agent asks before it commits. It calls
 * `simulate_action` first and only then `enforce_action` — which is what the
 * simulate tool exists for from a buyer's side. A refusal discovered by
 * simulating costs a round trip; a refusal discovered by enforcing costs a
 * refusal on the record and a dent in this agent's trust score.
 *
 * Every outcome the merchant can return is handled as an outcome, not an error.
 * An escalation in particular is not a failure: it means a human was asked, and
 * the right behaviour is to say so and move on rather than retry or crash.
 */

interface ActionOutcome {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  traceId: string;
  razorpayResponse?: { id?: string } | null;
  suggestions?: { sku: string; name: string; amountPaise: number; reason: string }[];
  counterOffer?: {
    offered: { sku: string; name: string; amountPaise: number };
    accepted: boolean;
    child?: { decision: string; reasoning: string };
  };
}

export class BuyerAgent {
  private readonly mcp: SignedMcpClient;
  private storefront: Storefront | null = null;
  private spentPaise = 0;
  private readonly bought: string[] = [];

  constructor() {
    this.mcp = new SignedMcpClient(config.mcpUrl, config.agentId, config.privateKey);
  }

  private get remainingPaise(): number {
    return Math.max(0, config.budgetPaise - this.spentPaise);
  }

  /** Discovery: who this merchant is, what they sell, what they can do. All of
   *  it over the wire, none of it assumed. */
  async introduce(): Promise<void> {
    this.storefront = await fetchStorefront();
    const tools = await this.mcp.listTools();

    rule();
    // Named first, because three buyers sharing one terminal are unreadable
    // otherwise -- every line below is identical in shape between profiles.
    if (config.profile) say(`I am the "${config.profile}" buyer.`);
    say(`Found a merchant: ${this.storefront.merchantName}`);
    indent(`${this.storefront.items.length} products, prices in ${this.storefront.currency}`);
    indent(`tools offered: ${tools.map((t) => t.name).join(", ") || "(none listed)"}`);
    indent(`my identity: ${config.agentId.slice(0, 8)}… (Ed25519, published in their key directory)`);
    indent(`my budget: ${money(config.budgetPaise)}`);
    // Printed when the merchant scopes this agent, so a short catalog reads as
    // a boundary rather than as a small shop.
    if (this.storefront.scopeNote) indent(this.storefront.scopeNote);
    rule();
  }

  /** One purchase, start to finish. Returns false when the agent is done —
   *  out of budget, or nothing left worth buying. */
  async buyOnce(): Promise<boolean> {
    if (!this.storefront) await this.introduce();
    const store = this.storefront!;

    if (this.remainingPaise <= 0) {
      say("Budget spent. Stopping.");
      return false;
    }

    // ---- think
    const choice = await chooseWhatToBuy(store.items, this.remainingPaise, this.bought);
    if (!choice) {
      say("Nothing left in this catalog that I need and can afford. Stopping.");
      return false;
    }
    say(`I want the ${choice.item.name} — ${money(choice.item.pricePaise)}`);
    indent(choice.fallback ? `[fallback, not a decision] ${choice.reason}` : `"${choice.reason}"`);

    // ---- check before committing
    const args = this.orderArgs(choice.item, choice.fallback ? undefined : choice.reason);
    let preview: ActionOutcome;
    try {
      preview = await this.mcp.callTool<ActionOutcome>("simulate_action", args);
    } catch (err) {
      return this.reportRejection(err);
    }

    /**
     * An escalation is not a refusal, and treating it as one was a real bug.
     *
     * This used to back off from anything that was not `allow`, which meant no
     * buyer could ever produce a pending escalation -- the merchant's whole
     * gated path was undemonstrable from the outside. Worse, it modelled the
     * exact behaviour this system exists to argue against: an agent that walks
     * away from a legitimate large purchase because a human would have to look
     * at it is how over-blocking destroys revenue.
     *
     * So `block` and `protocol_reject` still stop it -- committing there is
     * pointless, the answer will not change. `escalate` proceeds: the merchant
     * has said a person will decide, and a buyer that wants the item submits it
     * and waits. A profile can opt out (`BUYER_AVOIDS_ESCALATION=true`), which
     * is a persona choice -- someone stretching a small budget genuinely would
     * not wait on sign-off -- not a default.
     */
    if (preview.decision === "escalate" && !config.avoidsEscalation) {
      say("They will want a human to approve this. That is fine — I am submitting it anyway.");
      indent(preview.reasoning);
    } else if (preview.decision !== "allow") {
      const why =
        preview.decision === "escalate"
          ? "they would send it for approval, and I would rather not wait"
          : `they would ${preview.decision} it`;
      say(`Checked first — ${why}, so I am not committing.`);
      indent(preview.reasoning);
      this.bought.push(choice.item.sku); // don't ask again for the same thing
      return true;
    } else {
      indent("checked first: this would clear");
    }

    // ---- commit, and answer whatever comes back
    let outcome: ActionOutcome;
    try {
      outcome = await this.mcp.callTool<ActionOutcome>(args.name ? "enforce_action" : "enforce_action", args, (r) =>
        this.answerOffer(r, choice.item)
      );
    } catch (err) {
      return this.reportRejection(err);
    }

    this.reportPurchase(choice.item, outcome);
    return true;
  }

  private orderArgs(item: CatalogItem, reason?: string): Record<string, unknown> {
    return {
      actionType: "order.create",
      amount: item.pricePaise,
      currency: "INR",
      category: item.category,
      params: {
        receipt: `buyer-${Date.now()}`,
        // The SKU travels with the order so the merchant can attribute it
        // without guessing a product back out of a price.
        notes: {
          sku: item.sku,
          item: item.name,
          source: "autonomous-buyer",
          // Why this agent wanted it, in its own words. Sent so the merchant
          // can see the reasoning behind a purchase rather than only its
          // amount -- a refusal is easier to judge when you know what the
          // buyer thought it was doing. The merchant sanitises and bounds it
          // before storing; this side does not assume otherwise.
          ...(reason ? { agent_reason: reason } : {}),
        },
      },
    };
  }

  /**
   * The merchant asked a question mid-purchase. Read it, think about it, answer.
   *
   * The offer text is theirs, not ours — it is passed to the model as data and
   * never as instruction. See brain.ts.
   */
  private async answerOffer(
    requests: Record<string, InputRequestSpec>,
    parent: CatalogItem
  ): Promise<Record<string, unknown> | null> {
    const ask = requests.counter_offer;
    if (!ask) return null;

    const message = ask.params?.message ?? "(no message)";
    say("They came back with a counter-offer before completing it:");
    indent(`"${message}"`);

    const verdict = await decideOnOffer({
      offerMessage: message,
      parentName: parent.name,
      parentPaise: parent.pricePaise,
      remainingPaise: this.remainingPaise - parent.pricePaise,
    });

    say(verdict.accept ? "I'll take it." : "I'll pass on that.");
    indent(verdict.fallback ? `[fallback, not a decision] ${verdict.reason}` : `"${verdict.reason}"`);

    return {
      counter_offer: {
        action: "accept",
        // The verdict AND why. The merchant records the reason against the
        // trace, so a declined offer becomes signal about the offer rather
        // than a silent no.
        content: { accept: verdict.accept, reason: verdict.fallback ? undefined : verdict.reason },
      },
    };
  }

  private reportPurchase(item: CatalogItem, outcome: ActionOutcome): void {
    if (outcome.decision === "allow") {
      this.spentPaise += item.pricePaise;
      this.bought.push(item.sku);
      say(`Bought the ${item.name}. ${money(item.pricePaise)}.`);
      if (outcome.razorpayResponse?.id) indent(`razorpay order ${outcome.razorpayResponse.id}`);
    } else if (outcome.decision === "escalate") {
      // Not a failure. A human was asked, and the honest thing is to say so
      // rather than retry or treat it as an error.
      this.bought.push(item.sku);
      say(`Held for a human to approve. That is their call, not mine — moving on.`);
      indent(outcome.reasoning);
    } else {
      this.bought.push(item.sku);
      say(`Refused. Fair enough.`);
      indent(outcome.reasoning);
    }

    // The counter-offer's own outcome, which is separate from the parent's: an
    // accepted offer can still be refused by their policy.
    const counter = outcome.counterOffer;
    if (counter?.accepted && counter.child) {
      if (counter.child.decision === "allow") {
        this.spentPaise += counter.offered.amountPaise;
        this.bought.push(counter.offered.sku);
        say(`They added the ${counter.offered.name} too. ${money(counter.offered.amountPaise)}.`);
      } else {
        say(`I accepted the ${counter.offered.name}, but their policy ${counter.child.decision}ed it.`);
        indent(counter.child.reasoning);
      }
    } else if (counter && !counter.accepted) {
      this.bought.push(counter.offered.sku);
    }

    // The fallback path, for a merchant that cannot ask mid-call.
    if (outcome.suggestions?.length) {
      say(`They suggested: ${outcome.suggestions.map((s) => s.name).join(", ")}`);
      indent("(this merchant answered with suggestions rather than a counter-offer)");
    }

    indent(`trace ${outcome.traceId}`);
    indent(`budget left: ${money(this.remainingPaise)}`);
  }

  /** A refusal at the protocol layer is a different kind of event from a policy
   *  decision, and reads differently: it means this agent's identity or
   *  signature is wrong, not that its purchase was declined. */
  private reportRejection(err: unknown): boolean {
    if (err instanceof MerchantRejected) {
      if (err.detail.kind === "protocol_reject") {
        say("Rejected before they even looked at the purchase.");
        indent("My signature or my identity is not right for this merchant.");
        indent(err.detail.message);
        return false;
      }
      say(`Could not complete that: ${err.detail.message}`);
      return err.detail.kind !== "transport";
    }
    say(`Unexpected problem: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
