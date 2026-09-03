import { config } from "./config.js";
import { signGet } from "./signGet.js";

/**
 * Asking the merchant whether to work.
 *
 * This is a courtesy the agent extends, not a gate it is subject to. The
 * merchant does not refuse a paused agent's purchases — it simply says "not
 * now", and a well-behaved agent listens. Complying costs nothing and saves
 * this agent's model tokens; ignoring it would work, and would be visible.
 *
 * Signed the same way everything else is: the endpoint has to know which agent
 * is asking, and the answer is specific to this one.
 */

export interface ControlAnswer {
  status: "active" | "paused";
  paceMs: number;
  message: string;
  /** True when the merchant could not be asked. Treated as paused — see below. */
  unreachable: boolean;
}

export async function askIfIShouldWork(): Promise<ControlAnswer> {
  const url = new URL(config.controlUrl);
  try {
    const res = await fetch(url, { method: "GET", headers: signGet(url) });
    if (!res.ok) {
      return {
        status: "paused",
        paceMs: config.paceMs,
        message: `the merchant answered HTTP ${res.status}`,
        unreachable: true,
      };
    }
    const body = (await res.json()) as { status?: string; pace_ms?: number; message?: string };
    return {
      status: body.status === "paused" ? "paused" : "active",
      paceMs: typeof body.pace_ms === "number" ? body.pace_ms : config.paceMs,
      message: body.message ?? "",
      unreachable: false,
    };
  } catch (err) {
    // Fail SAFE, which here means fail STOPPED.
    //
    // The tempting default is to keep trading when the control channel is down
    // — "no news is good news". That is exactly backwards for an agent spending
    // someone else's money: if the merchant cannot be reached to say stop, the
    // one thing it might most want to say is stop. Waiting costs a delay;
    // guessing wrong costs money that is not ours.
    return {
      status: "paused",
      paceMs: config.paceMs,
      message: `could not reach the merchant (${err instanceof Error ? err.message : err})`,
      unreachable: true,
    };
  }
}
