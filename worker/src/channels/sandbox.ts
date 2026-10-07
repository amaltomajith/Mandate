import { randomUUID } from "node:crypto";
import type { ChannelDriver, InboundMessage, OutboundMessage, SendResult } from "./types";
import { simulateReplies } from "../sandbox/counterparties";

/**
 * The sandbox channel. Nothing sent here leaves the process: the "other side" is
 * simulated (see sandbox/counterparties.ts) and answers immediately. Every
 * message it produces is stored with `simulated = true`, so no screen can
 * mistake a rehearsal for a real conversation.
 */
export class SandboxDriver implements ChannelDriver {
  readonly channel = "sandbox" as const;
  readonly live = false;

  async send(message: OutboundMessage): Promise<SendResult> {
    const externalId = `sbx_${randomUUID()}`;
    const replies: InboundMessage[] = message.context
      ? simulateReplies(message.context).map((body) => ({
          from: message.to,
          subject: message.subject ? `Re: ${message.subject.replace(/^Re:\s*/i, "")}` : undefined,
          body,
          externalId: `sbx_${randomUUID()}`,
          threadExternalId: message.threadExternalId,
        }))
      : [];
    return { externalId, threadExternalId: message.threadExternalId, replies };
  }

  async poll(): Promise<InboundMessage[]> {
    return [];
  }
}
