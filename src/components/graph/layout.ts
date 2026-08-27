import type { Agent, Mandate, PolicyDomain, PolicyRule, Trace } from "@/types/db";

export type Vec3 = [number, number, number];

export interface PositionedAgent {
  agent: Agent;
  position: Vec3;
}
export interface PositionedRule {
  rule: PolicyRule;
  position: Vec3;
}
export interface PositionedTrace {
  trace: Trace;
  position: Vec3;
}
export interface PositionedMandate {
  mandate: Mandate;
  position: Vec3;
}
export interface PositionedDomain {
  domain: PolicyDomain;
  position: Vec3;
}

export interface GraphLayout {
  agents: PositionedAgent[];
  rules: PositionedRule[];
  traces: PositionedTrace[];
  mandates: PositionedMandate[];
  domains: PositionedDomain[];
  agentPositionById: Record<string, Vec3>;
  rulePositionById: Record<string, Vec3>;
  domainPositionById: Record<string, Vec3>;
}

/**
 * Deterministic, data-driven layout — no physics simulation, no randomness.
 * Layers by entity type: policy domains at the top, each domain's own rules
 * orbiting close beneath it (same "attached to its owner" visual language
 * mandates use for agents below), agents in the middle, each agent's own
 * transactions spiraling below/around it. The type-hue channel and the
 * spatial layout reinforce each other instead of fighting.
 */
export function computeLayout(
  agents: Agent[],
  rules: PolicyRule[],
  traces: Trace[],
  mandates: Mandate[] = [],
  domains: PolicyDomain[] = []
): GraphLayout {
  const DOMAIN_RADIUS = 9;
  const DOMAIN_Y = 7.5;
  const positionedDomains: PositionedDomain[] = domains.map((domain, i) => {
    const angle = (i / Math.max(domains.length, 1)) * Math.PI * 2;
    return { domain, position: [Math.cos(angle) * DOMAIN_RADIUS, DOMAIN_Y, Math.sin(angle) * DOMAIN_RADIUS] };
  });
  const domainPositionById: Record<string, Vec3> = Object.fromEntries(
    positionedDomains.map((p) => [p.domain.id, p.position])
  );

  // Rules orbit close beneath their own domain — same "attached to its
  // owner" language mandates use for agents, rather than a single ring
  // shared by every rule regardless of which domain governs it.
  const activeRules = rules.filter((r) => r.status === "active");
  const rulesByDomain = new Map<string, PolicyRule[]>();
  for (const rule of activeRules) {
    const key = rule.domain_id ?? "__no_domain__";
    const list = rulesByDomain.get(key) ?? [];
    list.push(rule);
    rulesByDomain.set(key, list);
  }

  const positionedRules: PositionedRule[] = [];
  for (const [domainId, domainRules] of rulesByDomain) {
    const base = domainPositionById[domainId] ?? [0, DOMAIN_Y, 0];
    const radius = 2;
    domainRules.forEach((rule, i) => {
      const angle = (i / Math.max(domainRules.length, 1)) * Math.PI * 2;
      positionedRules.push({
        rule,
        position: [base[0] + Math.cos(angle) * radius, base[1] - 1.8, base[2] + Math.sin(angle) * radius],
      });
    });
  }

  const AGENT_RADIUS = 4;
  const positionedAgents: PositionedAgent[] = agents.map((agent, i) => {
    const angle = (i / Math.max(agents.length, 1)) * Math.PI * 2;
    return { agent, position: [Math.cos(angle) * AGENT_RADIUS, 0, Math.sin(angle) * AGENT_RADIUS] };
  });

  const agentPositionById: Record<string, Vec3> = Object.fromEntries(
    positionedAgents.map((p) => [p.agent.id, p.position])
  );
  const rulePositionById: Record<string, Vec3> = Object.fromEntries(
    positionedRules.map((p) => [p.rule.id, p.position])
  );

  const byAgent = new Map<string, Trace[]>();
  for (const trace of traces) {
    const key = trace.agent_id ?? "__unassigned__";
    const list = byAgent.get(key) ?? [];
    list.push(trace);
    byAgent.set(key, list);
  }

  const positionedTraces: PositionedTrace[] = [];
  for (const [agentId, agentTraces] of byAgent) {
    const base = agentPositionById[agentId] ?? [0, -3.5, 0];
    const chronological = [...agentTraces].sort((a, b) => a.created_at.localeCompare(b.created_at));
    chronological.forEach((trace, i) => {
      const angle = i * 0.85;
      const radius = 1.1 + (i % 12) * 0.14;
      const y = base[1] - 1.6 - (i % 6) * 0.28;
      positionedTraces.push({
        trace,
        position: [base[0] + Math.cos(angle) * radius, y, base[2] + Math.sin(angle) * radius],
      });
    });
  }

  // Mandates orbit close above their agent — a standing authorization, not a
  // one-off event like a transaction, so it reads visually as "attached to"
  // the agent rather than spiraling away below it like the trace history.
  const byAgentMandates = new Map<string, Mandate[]>();
  for (const mandate of mandates) {
    const key = mandate.agent_id ?? "__unassigned__";
    const list = byAgentMandates.get(key) ?? [];
    list.push(mandate);
    byAgentMandates.set(key, list);
  }

  const positionedMandates: PositionedMandate[] = [];
  for (const [agentId, agentMandates] of byAgentMandates) {
    const base = agentPositionById[agentId] ?? [0, 0, 0];
    agentMandates.forEach((mandate, i) => {
      const angle = (i / Math.max(agentMandates.length, 1)) * Math.PI * 2;
      const radius = 1.5;
      positionedMandates.push({
        mandate,
        position: [base[0] + Math.cos(angle) * radius, base[1] + 1.15, base[2] + Math.sin(angle) * radius],
      });
    });
  }

  return {
    agents: positionedAgents,
    rules: positionedRules,
    traces: positionedTraces,
    mandates: positionedMandates,
    domains: positionedDomains,
    agentPositionById,
    rulePositionById,
    domainPositionById,
  };
}
