#!/usr/bin/env node
/**
 * Thin wrapper around `next dev`, for exactly one reason: extra CA trust.
 *
 * On a network that intercepts TLS — Sophos, Zscaler, most corporate and
 * campus setups — the certificate your server sees for Supabase is signed by
 * the interceptor, not by Supabase. Your browser accepts it because the OS
 * trusts that root; Node ships its own CA bundle that doesn't, so every
 * server-side query dies with `fetch failed` /
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while the site looks fine in a browser.
 *
 * Node only reads NODE_EXTRA_CA_CERTS at process start, so it can't be set
 * from inside the app. Setting it as a machine-level variable works but is
 * easy to lose (a shell opened before `setx`, a different terminal, a new
 * machine) — and it silently costs hours each time, because the failure looks
 * like a broken database rather than a broken trust store.
 *
 * So: put the path in `.env.local` (gitignored, machine-specific, where the
 * rest of this project's local config already lives) as MANDATE_CA_CERT, and
 * this sets NODE_EXTRA_CA_CERTS before handing off to `next dev`.
 *
 * A complete no-op when the variable is absent or the file is missing, which
 * is the normal case on an ordinary network — nobody cloning this repo is
 * affected, and no interceptor-specific certificate is committed.
 *
 * Export the interceptor's root from the OS trust store to get that file. On
 * Windows, PowerShell:
 *
 *   $c = Get-ChildItem Cert:\LocalMachine\Root |
 *          Where-Object { $_.Subject -like "*Sophos*" } | Select-Object -First 1
 *   $b64 = [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks')
 *   "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----" |
 *     Set-Content "$HOME\.certs\interceptor-root.pem" -Encoding ascii
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function readEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    out[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...process.env };

// An already-set NODE_EXTRA_CA_CERTS wins — if someone configured trust at the
// machine level, silently overriding it would be worse than doing nothing.
if (!env.NODE_EXTRA_CA_CERTS) {
  const caPath = readEnvLocal().MANDATE_CA_CERT;
  if (caPath && existsSync(caPath)) {
    env.NODE_EXTRA_CA_CERTS = caPath;
    console.log(`[dev] trusting extra CA from MANDATE_CA_CERT: ${caPath}`);
  } else if (caPath) {
    // Worth saying out loud: a configured-but-missing certificate looks
    // exactly like no certificate at all once queries start failing.
    console.warn(`[dev] MANDATE_CA_CERT is set but the file does not exist: ${caPath}`);
  }
}

const child = spawn("npx", ["next", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
