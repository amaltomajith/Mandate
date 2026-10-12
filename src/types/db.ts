// Hand-written to match supabase/migrations/0001_init.sql and 0002_products.sql —
// there's no live Supabase project to generate this from yet. Regenerate with
// `supabase gen types typescript` once one exists, and diff against this file
// before replacing it.
//
// `Relationships: []` on every table (rather than real foreign-key metadata) is
// deliberate: it satisfies supabase-js's GenericTable constraint without opting
// into its embedded-resource (`select("*, other_table(...)")`) type inference,
// which is easy to get subtly wrong by hand. Call sites do plain separate queries
// and join in application code instead — see src/lib/mcp/tools/explain.ts.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type PolicyRuleType =
  | "cap"
  | "velocity"
  | "category_block"
  | "catalog_scope"
  | "step_up"
  | "trust_floor"
  | "whitelisted_payee"
  | "min_margin_floor"
  | "payout_budget";
export type PolicyRuleStatus = "active" | "pending_review" | "rejected" | "superseded";
export type PolicyRuleSource = "human" | "horizon";
export type TraceMode = "simulate" | "enforce";
export type Decision = "allow" | "block" | "escalate" | "protocol_reject";
export type EscalationStatus = "pending" | "approved" | "denied";
export type AlertSeverity = "info" | "notable" | "high";
export type MandateType = "upi_autopay" | "ap2_style";
export type MandateStatus = "active" | "paused" | "revoked" | "expired";
export type AgentStatus = "active" | "paused";
export type AgentKind = "selling" | "buying" | "external";
export type Channel = "email" | "whatsapp" | "sandbox";
export type VendorStatus = "candidate" | "approved" | "blocked";
export type PayeeStatus = "pending" | "active" | "revoked";
export type PoStatus = "draft" | "quoting" | "awaiting_approval" | "approved" | "paid" | "received" | "cancelled";
export type PayoutStatus = "queued" | "processing" | "processed" | "failed" | "reversed";
export type ConnectionKind = "gmail" | "whatsapp" | "razorpay" | "razorpayx" | "search";
export type ConnectionStatus = "pending" | "connected" | "error" | "disconnected";

export interface Database {
  public: {
    Tables: {
      merchants: {
        Row: {
          id: string;
          clerk_user_id: string | null;
          name: string;
          slug: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          clerk_user_id?: string | null;
          name: string;
          slug: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["merchants"]["Insert"]>;
        Relationships: [];
      };
      customers: {
        Row: {
          merchant_id: string;
          id: string;
          name: string;
          email: string | null;
          razorpay_contact_id: string | null;
          phone: string | null;
          /** The Selling agent may only contact customers who opted in. */
          marketing_opt_in: boolean;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          name: string;
          email?: string | null;
          razorpay_contact_id?: string | null;
          phone?: string | null;
          marketing_opt_in?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["customers"]["Insert"]>;
        Relationships: [];
      };
      agents: {
        Row: {
          merchant_id: string;
          status: AgentStatus;
          /** True only for identities Mandate mints and signs as itself (the
           *  built-in traffic simulation). Its public key is rotated on each
           *  process start, which is safe because the merchant owns it. Always
           *  false for an agent registered through the dashboard: that key
           *  belongs to a third party and rotating it would lock them out. */
          managed: boolean;
          /** Categories this agent may transact. NULL is the full catalog --
           *  the default, and what every agent had before the column existed.
           *  An EMPTY array means nothing at all, which is a deliberate state
           *  rather than an unset one; the two read identically in a list of
           *  categories and are opposites, so anything displaying this has to
           *  say which it is showing. */
          catalog_scope: string[] | null;
          /** True hides the agent from the roster and the graph and stops its
           *  key verifying. Its past traces still resolve to its name --
           *  retirement hides the agent, never its history. Distinct from
           *  `status`, which is the cooperative pause an agent may ignore. */
          retired: boolean;
          /** selling/buying are the in-house COO agents; external is anything registered by key. */
          kind: AgentKind;
          /** In-house agents only; AES-GCM encrypted. Never sent to the browser. */
          secret_key_enc: string | null;
          /** How long the merchant asks this agent to wait between actions. A
           *  request the agent honours, not a limit the engine enforces —
           *  velocity rules are the limit. */
          pace_ms: number;
          /** What the agent is for, in the merchant's words. */
          persona: string | null;
          /** Where the agent runs, if the merchant recorded it. Never used to
           *  reach out — this system never calls an agent, agents call it. */
          endpoint_url: string | null;
          id: string;
          name: string;
          description: string | null;
          public_key: string;
          key_algorithm: string;
          key_registered_at: string;
          trust_score: number;
          trust_components: Json;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          managed?: boolean;
          catalog_scope?: string[] | null;
          retired?: boolean;
          kind?: AgentKind;
          secret_key_enc?: string | null;
          status?: AgentStatus;
          pace_ms?: number;
          persona?: string | null;
          endpoint_url?: string | null;
          id?: string;
          name: string;
          description?: string | null;
          public_key: string;
          key_algorithm?: string;
          key_registered_at?: string;
          trust_score?: number;
          trust_components?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["agents"]["Insert"]>;
        Relationships: [];
      };
      mandates: {
        Row: {
          merchant_id: string;
          id: string;
          agent_id: string | null;
          customer_id: string | null;
          type: MandateType;
          status: MandateStatus;
          raw_payload: Json;
          razorpay_ref: string | null;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          agent_id?: string | null;
          customer_id?: string | null;
          type: MandateType;
          status?: MandateStatus;
          raw_payload?: Json;
          razorpay_ref?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["mandates"]["Insert"]>;
        Relationships: [];
      };
      policy_rules: {
        Row: {
          merchant_id: string;
          id: string;
          type: PolicyRuleType;
          name: string;
          params: Json;
          status: PolicyRuleStatus;
          source: PolicyRuleSource;
          rationale: string | null;
          superseded_by: string | null;
          created_at: string;
          created_by: string | null;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          type: PolicyRuleType;
          name: string;
          params?: Json;
          status?: PolicyRuleStatus;
          source?: PolicyRuleSource;
          rationale?: string | null;
          superseded_by?: string | null;
          created_at?: string;
          created_by?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["policy_rules"]["Insert"]>;
        Relationships: [];
      };
      traces: {
        Row: {
          merchant_id: string;
          id: string;
          parent_trace_id: string | null;
          mode: TraceMode;
          action_type: string;
          params: Json;
          agent_id: string | null;
          decision: Decision;
          rule_fired_id: string | null;
          reasoning: string | null;
          razorpay_response: Json | null;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          parent_trace_id?: string | null;
          mode: TraceMode;
          action_type: string;
          params?: Json;
          agent_id?: string | null;
          decision: Decision;
          rule_fired_id?: string | null;
          reasoning?: string | null;
          razorpay_response?: Json | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["traces"]["Insert"]>;
        Relationships: [];
      };
      escalations: {
        Row: {
          merchant_id: string;
          id: string;
          trace_id: string;
          status: EscalationStatus;
          resolved_by: string | null;
          resolved_at: string | null;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          trace_id: string;
          status?: EscalationStatus;
          resolved_by?: string | null;
          resolved_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["escalations"]["Insert"]>;
        Relationships: [];
      };
      alerts: {
        Row: {
          merchant_id: string;
          id: string;
          trace_id: string | null;
          severity: AlertSeverity;
          message: string;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          trace_id?: string | null;
          severity: AlertSeverity;
          message: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["alerts"]["Insert"]>;
        Relationships: [];
      };
      seen_nonces: {
        Row: {
          nonce: string;
          agent_id: string | null;
          expires_at: string;
          created_at: string;
        };
        Insert: {
          nonce: string;
          agent_id?: string | null;
          expires_at: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["seen_nonces"]["Insert"]>;
        Relationships: [];
      };
      products: {
        Row: {
          merchant_id: string;
          id: string;
          sku: string;
          name: string;
          description: string;
          price_paise: number;
          category: string;
          /** False retires it: gone from /catalog, counter-offers and campaign
           *  planning, while past traces still resolve to its name. */
          active: boolean;
          /** Landed unit cost in paise; null = unknown (margin rule escalates). */
          cost_price_paise: number | null;
          stock_qty: number;
          reorder_point: number;
          lead_time_days: number;
          last_sold_at: string | null;
          /** Price before a clearance discount; null at normal price. */
          compare_at_price_paise: number | null;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          sku: string;
          name: string;
          description: string;
          price_paise: number;
          category: string;
          active?: boolean;
          cost_price_paise?: number | null;
          stock_qty?: number;
          reorder_point?: number;
          lead_time_days?: number;
          last_sold_at?: string | null;
          compare_at_price_paise?: number | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["products"]["Insert"]>;
        Relationships: [];
      };
      vendors: {
        Row: {
          merchant_id: string;
          id: string;
          name: string;
          channel: Channel;
          email: string | null;
          phone: string | null;
          website: string | null;
          status: VendorStatus;
          source: "manual" | "research";
          categories: string[];
          reliability: number;
          notes: string | null;
          simulated: boolean;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          name: string;
          channel?: Channel;
          email?: string | null;
          phone?: string | null;
          website?: string | null;
          status?: VendorStatus;
          source?: "manual" | "research";
          categories?: string[];
          reliability?: number;
          notes?: string | null;
          simulated?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["vendors"]["Insert"]>;
        Relationships: [];
      };
      payees: {
        Row: {
          merchant_id: string;
          id: string;
          vendor_id: string;
          kind: "bank" | "upi";
          display_name: string;
          masked_identifier: string;
          razorpay_contact_id: string | null;
          razorpay_fund_account_id: string | null;
          status: PayeeStatus;
          approved_by: string | null;
          approved_at: string | null;
          simulated: boolean;
          /** Manual-payout payees only: encrypted details, never sent to the browser as stored. */
          details_enc: string | null;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          vendor_id: string;
          kind: "bank" | "upi";
          display_name: string;
          masked_identifier: string;
          razorpay_contact_id?: string | null;
          razorpay_fund_account_id?: string | null;
          status?: PayeeStatus;
          approved_by?: string | null;
          approved_at?: string | null;
          simulated?: boolean;
          details_enc?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["payees"]["Insert"]>;
        Relationships: [];
      };
      agent_runs: {
        Row: {
          merchant_id: string;
          id: string;
          agent_id: string | null;
          kind: "selling" | "buying";
          status: "running" | "ok" | "error" | "halted";
          dry_run: boolean;
          summary: string | null;
          steps: Json;
          error: string | null;
          started_at: string;
          finished_at: string | null;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          agent_id?: string | null;
          kind: "selling" | "buying";
          status?: "running" | "ok" | "error" | "halted";
          dry_run?: boolean;
          summary?: string | null;
          steps?: Json;
          error?: string | null;
          started_at?: string;
          finished_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["agent_runs"]["Insert"]>;
        Relationships: [];
      };
      threads: {
        Row: {
          merchant_id: string;
          id: string;
          channel: Channel;
          kind: "vendor" | "buyer";
          counterparty: string;
          external_thread_id: string | null;
          vendor_id: string | null;
          customer_id: string | null;
          subject: string | null;
          status: "open" | "closed";
          last_message_at: string;
          /** Structured context, e.g. {"rfq": {"sku": "...", "qty": 40}} for a quote request. */
          meta: Json;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          channel: Channel;
          kind: "vendor" | "buyer";
          counterparty: string;
          external_thread_id?: string | null;
          vendor_id?: string | null;
          customer_id?: string | null;
          subject?: string | null;
          status?: "open" | "closed";
          last_message_at?: string;
          meta?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["threads"]["Insert"]>;
        Relationships: [];
      };
      messages: {
        Row: {
          merchant_id: string;
          id: string;
          thread_id: string;
          direction: "in" | "out";
          body: string;
          external_id: string | null;
          untrusted: boolean;
          handled: boolean;
          agent_run_id: string | null;
          simulated: boolean;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          thread_id: string;
          direction: "in" | "out";
          body: string;
          external_id?: string | null;
          untrusted?: boolean;
          handled?: boolean;
          agent_run_id?: string | null;
          simulated?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["messages"]["Insert"]>;
        Relationships: [];
      };
      quotes: {
        Row: {
          merchant_id: string;
          id: string;
          vendor_id: string;
          product_id: string | null;
          thread_id: string | null;
          unit_price_paise: number;
          moq: number;
          lead_time_days: number | null;
          valid_until: string | null;
          raw_excerpt: string | null;
          status: "open" | "accepted" | "expired" | "rejected";
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          vendor_id: string;
          product_id?: string | null;
          thread_id?: string | null;
          unit_price_paise: number;
          moq?: number;
          lead_time_days?: number | null;
          valid_until?: string | null;
          raw_excerpt?: string | null;
          status?: "open" | "accepted" | "expired" | "rejected";
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["quotes"]["Insert"]>;
        Relationships: [];
      };
      purchase_orders: {
        Row: {
          merchant_id: string;
          id: string;
          vendor_id: string;
          payee_id: string | null;
          quote_id: string | null;
          agent_id: string | null;
          status: PoStatus;
          total_paise: number;
          advance_paise: number;
          currency: string;
          rationale: string | null;
          expected_at: string | null;
          received_at: string | null;
          confirmed_at: string | null;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          vendor_id: string;
          payee_id?: string | null;
          quote_id?: string | null;
          agent_id?: string | null;
          status?: PoStatus;
          total_paise?: number;
          advance_paise?: number;
          currency?: string;
          rationale?: string | null;
          expected_at?: string | null;
          received_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["purchase_orders"]["Insert"]>;
        Relationships: [];
      };
      po_lines: {
        Row: {
          merchant_id: string;
          id: string;
          po_id: string;
          product_id: string;
          qty: number;
          unit_price_paise: number;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          po_id: string;
          product_id: string;
          qty: number;
          unit_price_paise: number;
        };
        Update: Partial<Database["public"]["Tables"]["po_lines"]["Insert"]>;
        Relationships: [];
      };
      payouts: {
        Row: {
          merchant_id: string;
          id: string;
          po_id: string | null;
          payee_id: string | null;
          trace_id: string | null;
          amount_paise: number;
          status: PayoutStatus;
          razorpay_payout_id: string | null;
          simulated: boolean;
          /** Paid by the merchant from their own bank; see manualPayouts.ts. */
          manual: boolean;
          paid_ref: string | null;
          paid_at: string | null;
          confirmed_by: string | null;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          po_id?: string | null;
          payee_id?: string | null;
          trace_id?: string | null;
          amount_paise: number;
          status?: PayoutStatus;
          razorpay_payout_id?: string | null;
          simulated?: boolean;
          manual?: boolean;
          paid_ref?: string | null;
          paid_at?: string | null;
          confirmed_by?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["payouts"]["Insert"]>;
        Relationships: [];
      };
      sales: {
        Row: {
          merchant_id: string;
          id: string;
          product_id: string | null;
          qty: number;
          amount_paise: number;
          source: "payment_link" | "order" | "manual";
          razorpay_payment_id: string | null;
          razorpay_order_id: string | null;
          captured_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          product_id?: string | null;
          qty?: number;
          amount_paise: number;
          source?: "payment_link" | "order" | "manual";
          razorpay_payment_id?: string | null;
          razorpay_order_id?: string | null;
          captured_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["sales"]["Insert"]>;
        Relationships: [];
      };
      wallet_entries: {
        Row: {
          merchant_id: string;
          id: string;
          direction: "credit" | "debit";
          amount_paise: number;
          kind: "sale" | "payout" | "refund" | "float" | "adjustment";
          ref_type: string | null;
          ref_id: string | null;
          note: string | null;
          simulated: boolean;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          direction: "credit" | "debit";
          amount_paise: number;
          kind: "sale" | "payout" | "refund" | "float" | "adjustment";
          ref_type?: string | null;
          ref_id?: string | null;
          note?: string | null;
          simulated?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["wallet_entries"]["Insert"]>;
        Relationships: [];
      };
      connections: {
        Row: {
          merchant_id: string;
          id: string;
          kind: ConnectionKind;
          status: ConnectionStatus;
          account_label: string | null;
          secret_enc: string | null;
          meta: Json;
          updated_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          kind: ConnectionKind;
          status?: ConnectionStatus;
          account_label?: string | null;
          secret_enc?: string | null;
          meta?: Json;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["connections"]["Insert"]>;
        Relationships: [];
      };
      webhook_events: {
        Row: { id: string; merchant_id: string | null; event: string; received_at: string };
        Insert: { id: string; merchant_id?: string | null; event: string; received_at?: string };
        Update: Partial<Database["public"]["Tables"]["webhook_events"]["Insert"]>;
        Relationships: [];
      };
      merchant_settings: {
        Row: {
          merchant_id: string;
          max_single_payout_paise: number;
          approval_threshold_paise: number;
          min_margin_bps: number;
          weekly_payout_budget_paise: number;
          payout_budget_pct: number;
          starting_float_paise: number;
          payout_mode: "auto" | "manual";
          require_approved_vendors: boolean;
          agents_enabled: boolean;
          dry_run: boolean;
          channel_mode: "sandbox" | "live";
          whatsapp_enabled: boolean;
          owner_phone: string | null;
          owner_approvals_enabled: boolean;
          owner_approval_max_paise: number;
          owner_briefing_enabled: boolean;
          owner_briefing_sent_on: string | null;
          updated_at: string;
        };
        Insert: {
          merchant_id: string;
          max_single_payout_paise?: number;
          approval_threshold_paise?: number;
          min_margin_bps?: number;
          weekly_payout_budget_paise?: number;
          payout_budget_pct?: number;
          starting_float_paise?: number;
          payout_mode?: "auto" | "manual";
          require_approved_vendors?: boolean;
          agents_enabled?: boolean;
          dry_run?: boolean;
          channel_mode?: "sandbox" | "live";
          whatsapp_enabled?: boolean;
          owner_phone?: string | null;
          owner_approvals_enabled?: boolean;
          owner_approval_max_paise?: number;
          owner_briefing_enabled?: boolean;
          owner_briefing_sent_on?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["merchant_settings"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {
      product_stats: {
        Row: {
          product_id: string;
          merchant_id: string;
          units_14d: number;
          units_30d: number;
          revenue_30d_paise: number;
          last_sale_at: string | null;
        };
        Relationships: [];
      };
    };
    Functions: Record<string, never>;
  };
}

export type Agent = Database["public"]["Tables"]["agents"]["Row"];
export type PolicyRule = Database["public"]["Tables"]["policy_rules"]["Row"];
export type Trace = Database["public"]["Tables"]["traces"]["Row"];
export type Escalation = Database["public"]["Tables"]["escalations"]["Row"];
export type Alert = Database["public"]["Tables"]["alerts"]["Row"];
export type Customer = Database["public"]["Tables"]["customers"]["Row"];
export type Mandate = Database["public"]["Tables"]["mandates"]["Row"];
export type Product = Database["public"]["Tables"]["products"]["Row"];
export type Merchant = Database["public"]["Tables"]["merchants"]["Row"];
export type Vendor = Database["public"]["Tables"]["vendors"]["Row"];
export type Payee = Database["public"]["Tables"]["payees"]["Row"];
export type AgentRun = Database["public"]["Tables"]["agent_runs"]["Row"];
export type Thread = Database["public"]["Tables"]["threads"]["Row"];
export type Message = Database["public"]["Tables"]["messages"]["Row"];
export type Quote = Database["public"]["Tables"]["quotes"]["Row"];
export type PurchaseOrder = Database["public"]["Tables"]["purchase_orders"]["Row"];
export type PoLine = Database["public"]["Tables"]["po_lines"]["Row"];
export type Payout = Database["public"]["Tables"]["payouts"]["Row"];
export type Sale = Database["public"]["Tables"]["sales"]["Row"];
export type WalletEntry = Database["public"]["Tables"]["wallet_entries"]["Row"];
export type Connection = Database["public"]["Tables"]["connections"]["Row"];
export type MerchantSettings = Database["public"]["Tables"]["merchant_settings"]["Row"];
export type ProductStats = Database["public"]["Views"]["product_stats"]["Row"];
