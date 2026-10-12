"use client";

/**
 * The last resort: the root layout itself failed. It replaces the whole document,
 * so it carries its own markup and inline styles (the app's CSS is not loaded here).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#050507", color: "#f3f1fb", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ maxWidth: 480, padding: 32, textAlign: "center" }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>Mandate could not start</h1>
          <p style={{ color: "#9a96b2", lineHeight: 1.6 }}>Something went wrong loading the app. Nothing was changed. Try again in a moment.</p>
          {error.digest && <p style={{ color: "#8a86a3", fontSize: 12 }}>Reference {error.digest}</p>}
          <button
            type="button"
            onClick={() => retry()}
            style={{ marginTop: 16, minHeight: 44, padding: "0 24px", borderRadius: 12, border: 0, color: "#fff", fontSize: 15, fontWeight: 600, background: "linear-gradient(135deg, #7c5cff, #5227ff)", cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
