"use client";

import { useSyncExternalStore } from "react";
import { relativeTime } from "./ui";

/**
 * A fixed point both renders agree on: the instant itself, in UTC.
 *
 * Deliberately not localised. The whole problem being solved is that the server
 * and the browser disagree, and `toLocaleString` is a second way for them to do
 * that — a server in UTC and a reader in IST produce different text for the
 * same moment, which is a mismatch that only shows up in deployment.
 */
function absoluteUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toISOString().slice(11, 16)} UTC`;
}

/** Nothing to subscribe to: the value flips once, at hydration, and never
 *  again. */
const noSubscribe = () => () => {};

/**
 * Elapsed time, rendered without lying to the hydrator.
 *
 * `useSyncExternalStore` is React's sanctioned way to say "the server and the
 * client legitimately know different things". The server snapshot is `false`,
 * so SSR emits a fixed UTC timestamp; the client snapshot is `true`, so the
 * first browser render — and every one after — shows elapsed time. Both sides
 * of the hydration boundary render the *same* thing, and the swap happens
 * afterwards as an ordinary update.
 *
 * The obvious alternatives are both worse. `suppressHydrationWarning` silences
 * the warning without fixing the mismatch, which means the next real one hides
 * behind it. A `useState` + `useEffect` mount flag works but sets state from an
 * effect purely to describe something that was already true before the first
 * render, and the lint rule that objects to that is right to.
 */
export function TimeAgo({ iso }: { iso: string }) {
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false
  );
  return <>{hydrated ? relativeTime(iso) : absoluteUtc(iso)}</>;
}
