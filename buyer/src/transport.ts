import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";

// @noble/ed25519 ships async-only by default; wiring in a sync sha512 unlocks
// the sync sign call below.
ed.hashes.sha512 = sha512;

/**
 * Signed MCP transport, protocol revision 2026-07-28.
 *
 * This is a COPY of the merchant's own client, not an import of it, and the
 * duplication is the point of the exercise. A real third-party buying agent
 * has no access to the merchant's source tree — it has their public catalog,
 * their published key directory, and the wire protocol. If this file imported
 * from `src/`, the isolation the whole agent is meant to demonstrate would be
 * a claim rather than a fact, and the demo would be theatre.
 *
 * So everything the wire needs is reimplemented here from the spec shape:
 * Ed25519 over the RFC 9421-style signature base, the `Mcp-Method` /
 * `Mcp-Name` header mirroring 2026-07-28 requires, the per-request `_meta`
 * envelope, and the MRTR retry leg.
 *
 * If the merchant changes their signature base, this breaks — and it *should*
 * break, loudly, at verification. That is what an independent implementation
 * buys you: a second opinion about what the protocol says.
 */

const COVERED_COMPONENTS = ["@method", "@path", "@authority", "content-digest"] as const;

function contentDigest(body: string): string {
  const digest = sha256(new TextEncoder().encode(body));
  return `sha-256=:${Buffer.from(digest).toString("base64")}:`;
}

function signatureInputHeader(keyid: string, created: number): string {
  const components = COVERED_COMPONENTS.map((c) => `"${c}"`).join(" ");
  return `sig1=(${components});created=${created};keyid="${keyid}";alg="ed25519"`;
}

/** The exact bytes both sides sign. Byte-identical or verification fails. */
function signatureBase(input: {
  method: string;
  path: string;
  authority: string;
  digest: string;
  sigInput: string;
}): string {
  return [
    `"@method": ${input.method.toUpperCase()}`,
    `"@path": ${input.path}`,
    `"@authority": ${input.authority}`,
    `"content-digest": ${input.digest}`,
    `"@signature-params": ${input.sigInput.replace(/^sig1=/, "")}`,
  ].join("\n");
}

export interface InputRequestSpec {
  method?: string;
  params?: {
    message?: string;
    mode?: string;
    url?: string;
    requestedSchema?: unknown;
  };
}

export interface RawToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
  resultType?: string;
  inputRequests?: Record<string, InputRequestSpec>;
  requestState?: string;
}

/**
 * Answers a counter-offer. Returns the `inputResponses` map the retry carries,
 * or `null` to abandon the round trip without answering.
 */
export type InputRequiredHandler = (
  requests: Record<string, InputRequestSpec>
) => Promise<Record<string, unknown> | null>;

export interface McpError {
  kind: "protocol_reject" | "transport" | "tool_error";
  status?: number;
  message: string;
}

export class MerchantRejected extends Error {
  constructor(
    readonly detail: McpError,
    message?: string
  ) {
    super(message ?? detail.message);
    this.name = "MerchantRejected";
  }
}

export class SignedMcpClient {
  private nextId = 1;

  constructor(
    private readonly endpoint: string,
    private readonly agentId: string,
    private readonly privateKeyBase64: string
  ) {}

  /**
   * The per-request `_meta` envelope 2026-07-28 carries in place of the
   * handshake there no longer is. Capabilities travel on every call, which is
   * what lets a stateless merchant answer each one correctly.
   *
   * `elicitation` is declared deliberately. Without it the merchant takes its
   * suggestions fallback and never offers anything mid-call — the counter-offer
   * path would be dead on this side too.
   */
  private envelope(): Record<string, unknown> {
    return {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "autonomous-buyer", version: "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
    };
  }

  private async post(body: unknown): Promise<{ result?: RawToolResult; error?: { message: string } }> {
    const url = new URL(this.endpoint);
    const bodyText = JSON.stringify(body);
    const envelopeBody = body as { method?: string; params?: { name?: string } };

    const created = Math.floor(Date.now() / 1000);
    const digest = contentDigest(bodyText);
    const sigInput = signatureInputHeader(this.agentId, created);
    const base = signatureBase({
      method: "POST",
      path: url.pathname + url.search,
      authority: url.host,
      digest,
      sigInput,
    });
    const signature = ed.sign(
      new TextEncoder().encode(base),
      Buffer.from(this.privateKeyBase64, "base64")
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          // 2026-07-28 requires the method and tool name to be mirrored in
          // headers, and refuses a request whose headers and body disagree.
          // Neither is signed and neither needs to be: the body is covered by
          // content-digest, so an altered header cannot change what executes,
          // only produce a mismatch the merchant rejects.
          ...(envelopeBody?.method ? { "mcp-method": envelopeBody.method } : {}),
          ...(envelopeBody?.params?.name ? { "mcp-name": envelopeBody.params.name } : {}),
          "content-digest": digest,
          "signature-input": sigInput,
          signature: `sig1=:${Buffer.from(signature).toString("base64")}:`,
        },
        body: bodyText,
      });
    } catch (err) {
      throw new MerchantRejected({
        kind: "transport",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (res.status === 401) {
      // The merchant refused at the protocol layer, before any policy ran. For
      // a buyer this means its signature or its identity is wrong — not that
      // the purchase was declined.
      throw new MerchantRejected({
        kind: "protocol_reject",
        status: 401,
        message: (await res.text()).slice(0, 200),
      });
    }
    if (!res.ok) {
      throw new MerchantRejected({
        kind: "transport",
        status: res.status,
        message: (await res.text()).slice(0, 200),
      });
    }
    return res.json() as Promise<{ result?: RawToolResult; error?: { message: string } }>;
  }

  /** One post, no retry. Exposed so a caller can inspect an `input_required`
   *  and decide about it deliberately. */
  async callOnce(
    name: string,
    args: Record<string, unknown>,
    extra?: { inputResponses?: Record<string, unknown>; requestState?: string }
  ): Promise<RawToolResult> {
    const params: Record<string, unknown> = { name, arguments: args, _meta: this.envelope() };
    if (extra?.inputResponses) params.inputResponses = extra.inputResponses;
    // Echoed VERBATIM. It is the merchant's sealed state: opaque, integrity
    // protected, and none of this agent's business. Parsing or rebuilding it
    // would at best fail verification and at worst look like an attempt to
    // forge one.
    if (extra?.requestState !== undefined) params.requestState = extra.requestState;

    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params,
    });
    if (response.error) {
      throw new MerchantRejected({ kind: "tool_error", message: response.error.message });
    }
    if (!response.result) {
      throw new MerchantRejected({ kind: "tool_error", message: `${name} returned no result` });
    }
    return response.result;
  }

  /**
   * Calls a tool, answering counter-offers along the way.
   *
   * Rounds are bounded. A merchant that kept asking would otherwise spin this
   * agent forever, and an unbounded retry loop driving real money actions is
   * not a loop anyone should ship.
   */
  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    onInputRequired?: InputRequiredHandler,
    maxRounds = 3
  ): Promise<T> {
    let inputResponses: Record<string, unknown> | undefined;
    let requestState: string | undefined;

    for (let round = 0; round < maxRounds; round++) {
      const result = await this.callOnce(name, args, { inputResponses, requestState });

      if (result.resultType === "input_required") {
        if (!onInputRequired) {
          throw new MerchantRejected({
            kind: "tool_error",
            message: `${name} asked for input and this call was given no way to answer.`,
          });
        }
        const answers = await onInputRequired(result.inputRequests ?? {});
        if (answers === null) return result as T;
        inputResponses = answers;
        requestState = result.requestState;
        continue;
      }

      const text = result.content?.find((c) => c.type === "text")?.text;
      if (!text) {
        throw new MerchantRejected({ kind: "tool_error", message: `${name} returned no text content` });
      }
      if (result.isError) {
        throw new MerchantRejected({ kind: "tool_error", message: text });
      }
      return JSON.parse(text) as T;
    }

    throw new MerchantRejected({
      kind: "tool_error",
      message: `${name} still wanted input after ${maxRounds} rounds.`,
    });
  }

  /** Whatever the merchant says it can do. Read over the wire rather than
   *  assumed — a buyer that hardcodes a merchant's tool list is a buyer that
   *  breaks silently when the merchant adds one. */
  async listTools(): Promise<{ name: string; description?: string }[]> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/list",
      params: { _meta: this.envelope() },
    });
    const tools = (response.result as unknown as { tools?: { name: string; description?: string }[] })?.tools;
    return tools ?? [];
  }
}
