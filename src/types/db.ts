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

export type PolicyRuleType = "cap" | "velocity" | "category_block" | "step_up" | "trust_floor";
export type PolicyRuleStatus = "active" | "pending_review" | "rejected" | "superseded";
export type PolicyRuleSource = "human" | "horizon";
export type TraceMode = "simulate" | "enforce";
export type Decision = "allow" | "block" | "escalate" | "protocol_reject";
export type EscalationStatus = "pending" | "approved" | "denied";
export type AlertSeverity = "info" | "notable" | "high";
export type MandateType = "upi_autopay" | "ap2_style";
export type MandateStatus = "active" | "paused" | "revoked" | "expired";
export type AgentStatus = "active" | "paused";
export type CampaignStatus = "draft" | "running" | "paused" | "done";
export type CampaignTargetStatus = "pending" | "offered" | "paid" | "expired" | "refused" | "held";

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
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          name: string;
          email?: string | null;
          razorpay_contact_id?: string | null;
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
      campaigns: {
        Row: {
          merchant_id: string;
          id: string;
          name: string;
          goal: string;
          plan: Json;
          budget_paise: number;
          status: CampaignStatus;
          agent_id: string | null;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          name: string;
          goal: string;
          plan?: Json;
          budget_paise: number;
          status?: CampaignStatus;
          agent_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["campaigns"]["Insert"]>;
        Relationships: [];
      };
      campaign_targets: {
        Row: {
          merchant_id: string;
          id: string;
          campaign_id: string;
          customer_id: string | null;
          trace_id: string | null;
          payment_link_id: string | null;
          payment_link_url: string | null;
          status: CampaignTargetStatus;
          amount_paise: number;
          discount_paise: number;
          created_at: string;
        };
        Insert: {
          merchant_id: string;
          id?: string;
          campaign_id: string;
          customer_id?: string | null;
          trace_id?: string | null;
          payment_link_id?: string | null;
          payment_link_url?: string | null;
          status?: CampaignTargetStatus;
          amount_paise: number;
          discount_paise?: number;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["campaign_targets"]["Insert"]>;
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
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["products"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
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
export type Campaign = Database["public"]["Tables"]["campaigns"]["Row"];
export type CampaignTarget = Database["public"]["Tables"]["campaign_targets"]["Row"];
