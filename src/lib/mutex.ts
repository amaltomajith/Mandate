/**
 * A per-key async mutex: callers with the same key run one at a time, in order.
 *
 * The Payment Wall reads what has been spent, decides, and then records the
 * decision. Two enforce calls for one merchant racing through that window would
 * each see the same "spent so far" and could together exceed a daily cap or the
 * restock budget. Serialising enforce calls per merchant closes that window.
 *
 * Honest scope: this is in-process. It makes one server instance safe, and the
 * in-house agents are additionally serialised by the agent_runs lock. A
 * deployment with several instances and external agents calling in parallel
 * would need a database-level lock (a Postgres advisory lock inside a function)
 * to make the same guarantee across instances.
 */
const tails = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mine = prev.then(() => gate);
  tails.set(key, mine);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === mine) tails.delete(key);
  }
}
