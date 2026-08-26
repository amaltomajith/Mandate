import type { Agent, Mandate, PolicyRule, Trace } from "@/types/db";

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

export interface GraphLayout {
  agents: PositionedAgent[];
  rules: PositionedRule[];
  traces: PositionedTrace[];
  mandates: PositionedMandate[];
  agentPositionById: Record<string, Vec3>;
  rulePositionById: Record<string, Vec3>;
}

/**
 * Deterministic, data-driven layout — no physics simulation, no randomness.
 * Three layers by entity type (rules above, agents in the middle, each agent's
 * own transactions spiraling below/around it) so the type-hue channel and the
 * spatial layout reinforce each other instead of fighting.
 */
export function computeLayout(
  agents: Agent[],
  rules: PolicyRule[],
  traces: Trace[],
  mandates: Mandate[] = []
): GraphLayout {
  const activeRules = rules.filter((r) => r.status === "active");

  const RULE_RADIUS = 6;
  const positionedRules: PositionedRule[] = activeRules.map((rule, i) => {
    const angle = (i / Math.max(activeRules.length, 1)) * Math.PI * 2;
    return { rule, position: [Math.cos(angle) * RULE_RADIUS, 4.5, Math.sin(angle) * RULE_RADIUS] };
  });

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
    agentPositionById,
    rulePositionById,
  };
}
