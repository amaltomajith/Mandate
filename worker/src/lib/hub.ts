import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * One surface over many MCP servers.
 *
 * Each capability (the store, the channels, web research, the Payment Wall) is a
 * real MCP server. The hub connects to each as a client, namespaces their tools
 * (`store_get_inventory`, `wall_enforce_action`), and exposes them in the shape a
 * model's tool-calling API wants. Local servers are linked in memory; the wall is
 * a remote server reached over signed HTTP. To the agent they are the same.
 *
 * An agent is only ever handed the tools in its allow-list, so a tool an agent
 * has no business using is not merely forbidden, it is not in the prompt.
 */

export interface HubTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface HubResult {
  text: string;
  isError: boolean;
}

export class ToolHub {
  private routes = new Map<string, { client: Client; tool: string }>();
  private defs = new Map<string, HubTool>();
  private clients: Client[] = [];

  async mountServer(prefix: string, server: McpServer): Promise<void> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: `hub-${prefix}`, version: "0.3.0" });
    await client.connect(clientTransport);
    await this.mountClient(prefix, client);
  }

  async mountClient(prefix: string, client: Client): Promise<void> {
    this.clients.push(client);
    const { tools } = await client.listTools();
    for (const t of tools) {
      const name = `${prefix}_${t.name}`;
      if (name.length > 64) throw new Error(`Tool name too long for a model API: ${name}`);
      const { $schema: _ignored, ...schema } = (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;
      void _ignored;
      this.routes.set(name, { client, tool: t.name });
      this.defs.set(name, { name, description: t.description ?? t.title ?? t.name, parameters: schema });
    }
  }

  /** Tools in model-API shape, limited to `allow`. */
  list(allow: (name: string) => boolean): HubTool[] {
    return [...this.defs.values()].filter((t) => allow(t.name));
  }

  has(name: string): boolean {
    return this.routes.has(name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<HubResult> {
    const route = this.routes.get(name);
    if (!route) return { text: `Unknown tool "${name}".`, isError: true };
    try {
      const res = (await route.client.callTool({ name: route.tool, arguments: args })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (res.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
      return { text, isError: res.isError === true };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
    this.clients = [];
    this.routes.clear();
    this.defs.clear();
  }
}

/** A model-API tool JSON from a hub tool. */
export function toOpenAiTool(t: HubTool) {
  return { type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } };
}
