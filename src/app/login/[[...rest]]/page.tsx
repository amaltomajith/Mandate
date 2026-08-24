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
            card: "shadow-none border-0 p-0 w-full",
          },
        }}
      />
    </AuthShell>
  );
}
