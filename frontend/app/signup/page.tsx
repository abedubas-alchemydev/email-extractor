import { AuthForm } from "@/components/auth/auth-form";

export const metadata = {
  title: "Create account · Email Extractor",
};

export default function SignupPage(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            Email and password — you&apos;ll have tool access immediately.
          </p>
        </header>
        <AuthForm mode="signup" />
      </div>
    </main>
  );
}
