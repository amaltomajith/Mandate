import type { Channel } from "@/types/db";

/** A message to send. `context` is for drivers that simulate a counterparty; real
 *  channels ignore it. */
export interface OutboundMessage {
  to: string;
  subject?: string;
  body: string;
  threadExternalId?: string;
  context?: SandboxContext;
}

export interface InboundMessage {
  from: string;
  subject?: string;
  body: string;
  externalId: string;
  threadExternalId?: string;
  at?: Date;
  /** The body is a transcript of a voice note. */
  voice?: boolean;
}

export interface SendResult {
  externalId: string;
  threadExternalId?: string;
  /** Sandbox only: the counterparty's immediate replies. */
  replies?: InboundMessage[];
}

/**
 * What the sandbox needs to play the other side of a conversation believably.
 * Computed by the agent's own tools from the merchant's records, never typed by
 * a model.
 */
export type SandboxContext =
  | { kind: "rfq"; sku: string; name: string; qty: number; listPricePaise: number; counterparty: string; notes?: string | null; round: number }
  | { kind: "offer"; sku: string; name: string; askPaise: number; qty: number; counterparty: string; round: number }
  | { kind: "negotiation"; sku: string; name: string; askPaise: number; counterpartyOfferPaise: number | null; counterparty: string; round: number }
  | { kind: "other"; counterparty: string; round: number };

export interface ChannelDriver {
  /** Told that a polled message was dealt with (filed or deliberately ignored), so it is not fetched again. */
  ack?(externalId: string): void;
  channel: Channel;
  /** False for the sandbox: nothing it sends reaches a real person. */
  live: boolean;
  send(message: OutboundMessage): Promise<SendResult>;
  poll(): Promise<InboundMessage[]>;
}
