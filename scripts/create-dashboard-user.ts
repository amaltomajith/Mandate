/**
 * Creates (or resets the password of) the merchant dashboard login. This is
 * Supabase Auth — the human login — not an agent identity (see gen-agent-key.ts
 * for those).
 *
 * Usage: npx tsx scripts/create-dashboard-user.ts you@merchant.com "some-password"
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npx tsx scripts/create-dashboard-user.ts <email> "<password>"');
    process.exit(1);
  }

  const db = createAdminClient();
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (!createError) {
    console.log(`Dashboard user created: ${created.user?.email} (${created.user?.id})`);
    return;
  }

  // Already exists — reset its password instead.
  const { data: list, error: listError } = await db.auth.admin.listUsers();
  if (listError) throw listError;
  const existing = list.users.find((u) => u.email === email);
  if (!existing) throw createError;

  const { error: updateError } = await db.auth.admin.updateUserById(existing.id, { password });
  if (updateError) throw updateError;
  console.log(`Dashboard user already existed — password updated for ${email} (${existing.id})`);
}

main();
