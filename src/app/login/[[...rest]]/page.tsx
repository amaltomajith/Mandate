import { SignIn } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth/AuthShell";

export default function LoginPage() {
  return (
    <AuthShell>
      <SignIn
        routing="path"
        path="/login"
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/dashboard"
        appearance={{
          elements: {
            rootBox: "w-full",
            cardBox: "w-full",
            // A plain className string here loses the cascade fight against
            // Clerk's own internal card styles (its box-shadow won regardless
            // of a `shadow-none` class) — the object form applies as real
            // inline-priority styles instead, which actually wins.
            card: { boxShadow: "none", border: "none", backgroundColor: "transparent" },
          },
        }}
      />
    </AuthShell>
  );
}
