import { AuthForm } from "@/components/auth/auth-form";

export const metadata = {
  title: "Sign in · Email Extractor",
};

export default function LoginPage(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            Sign in to the Email Extractor.
          </p>
        </header>
        <AuthForm mode="login" />
      </div>
    </main>
  );
}
