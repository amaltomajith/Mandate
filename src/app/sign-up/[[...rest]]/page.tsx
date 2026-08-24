import { SignUp } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth/AuthShell";

export default function SignUpPage() {
  return (
    <AuthShell>
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/login"
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
