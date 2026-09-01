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
export type CampaignStatus = "draft" | "running" | "paused" | "done";
export type CampaignTargetStatus = "pending" | "offered" | "paid" | "expired" | "refused" | "held";

export interface Database {
  public: {
    Tables: {
      customers: {
        Row: {
          id: string;
          name: string;
          email: string | null;
          razorpay_contact_id: string | null;
          created_at: string;
        };
        Insert: {
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
          id: string;
          trace_id: string;
          status: EscalationStatus;
          resolved_by: string | null;
          resolved_at: string | null;
          created_at: string;
        };
        Insert: {
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
          id: string;
          trace_id: string | null;
          severity: AlertSeverity;
          message: string;
          created_at: string;
        };
        Insert: {
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
      products: {
        Row: {
          id: string;
          sku: string;
          name: string;
          description: string;
          price_paise: number;
          category: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          sku: string;
          name: string;
          description: string;
          price_paise: number;
          category: string;
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
export type Campaign = Database["public"]["Tables"]["campaigns"]["Row"];
export type CampaignTarget = Database["public"]["Tables"]["campaign_targets"]["Row"];
