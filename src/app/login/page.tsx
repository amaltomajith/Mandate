"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mb-2 inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--entity-agent)" }} />
            <h1 className="text-xl font-semibold tracking-tight">Mandate</h1>
          </div>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Merchant control-plane sign-in
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-xl border p-6"
          style={{ background: "var(--panel)", borderColor: "var(--panel-border)" }}
        >
          <label className="mb-1 block text-xs" style={{ color: "var(--muted)" }}>
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1"
            style={{ borderColor: "var(--panel-border)" }}
            placeholder="you@merchant.com"
          />

          <label className="mb-1 block text-xs" style={{ color: "var(--muted)" }}>
            Password
          </label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1"
            style={{ borderColor: "var(--panel-border)" }}
            placeholder="••••••••"
          />

          {error && (
            <p className="mb-4 text-sm" style={{ color: "var(--decision-block)" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md py-2 text-sm font-medium text-black transition disabled:opacity-60"
            style={{ background: "var(--entity-agent)" }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs" style={{ color: "var(--muted)" }}>
          No account? Create one with{" "}
          <code className="rounded bg-black/30 px-1 py-0.5">npm run create-dashboard-user</code>
        </p>
      </div>
    </div>
  );
}
