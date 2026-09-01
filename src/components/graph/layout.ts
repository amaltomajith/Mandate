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
 * Layers by entity type: policy rules on the top tier, agents in the middle,
 * each agent's mandates orbiting just above it and its transactions spiraling
 * below. The type-hue channel and the spatial layout reinforce each other
 * instead of fighting — height alone tells you what kind of thing a node is.
 */
export function computeLayout(
  agents: Agent[],
  rules: PolicyRule[],
  traces: Trace[],
  mandates: Mandate[] = []
): GraphLayout {
  const RULE_Y = 5.7;
  // Rules ring the scene above the agents — one tier per entity type, so
  // height alone tells you what kind of thing you are looking at.
  const activeRules = rules.filter((r) => r.status === "active");
  const RULE_RADIUS = 6;
  const positionedRules: PositionedRule[] = activeRules.map((rule, i) => {
    const angle = (i / Math.max(activeRules.length, 1)) * Math.PI * 2;
    return { rule, position: [Math.cos(angle) * RULE_RADIUS, RULE_Y, Math.sin(angle) * RULE_RADIUS] as Vec3 };
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
  // A mandate authorizes ONE agent to act for ONE customer, so a mandate whose
  // agent no longer exists authorizes nobody — checkMandateGate looks it up by
  // (agent_id, customer_id) and can never match one. It is inert.
  //
  // Such rows used to land in an "__unassigned__" bucket, get positioned at the
  // origin, and render floating with no edge (mandateEdges skips them, having
  // no agent to draw from) while still showing an "ACTIVE — AUTHORIZED" badge.
  // That is a node claiming a relationship that does not exist, so it is left
  // out of the layout rather than drawn as an unexplained outlier.
  const byAgentMandates = new Map<string, Mandate[]>();
  for (const mandate of mandates) {
    if (!mandate.agent_id || !agentPositionById[mandate.agent_id]) continue;
    const list = byAgentMandates.get(mandate.agent_id) ?? [];
    list.push(mandate);
    byAgentMandates.set(mandate.agent_id, list);
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
