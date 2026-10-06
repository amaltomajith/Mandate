// The worker is a plain Node process, not a Next.js server bundle, so the
// `server-only` guard (which throws outside Next's server context) is replaced
// by this empty module via tsconfig paths. Nothing here ever reaches a browser.
export {};
