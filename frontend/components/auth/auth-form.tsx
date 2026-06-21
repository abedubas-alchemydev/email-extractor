"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState, useTransition } from "react";

import { authClient } from "@/lib/auth-client";

type AuthFormMode = "login" | "signup";

// Email + password only. New signups auto-provision with tool access (the DB
// defaults role=viewer, status=active, feature_permissions=['email_extractor']),
// so a successful sign-in/sign-up lands straight on the gated tool — no
// email-verification or admin-approval step.
export function AuthForm({ mode }: { mode: AuthFormMode }): React.ReactElement {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const name = String(formData.get("name") ?? "").trim();

    setError(null);

    if (mode === "signup") {
      if (!name) {
        setError("Please enter your full name.");
        return;
      }
      if (password.length < 8) {
        setError("Password must be at least 8 characters.");
        return;
      }
      const confirmPassword = String(formData.get("confirmPassword") ?? "");
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
    }

    startTransition(async () => {
      try {
        if (mode === "signup") {
          const result = await authClient.signUp.email({ name, email, password });
          if (result.error) throw new Error(result.error.message);
        } else {
          const result = await authClient.signIn.email({ email, password });
          if (result.error) throw new Error(result.error.message);
        }
        router.push("/email-extractor");
        router.refresh();
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : "Unable to continue.");
      }
    });
  }

  const fieldClass =
    "w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-neutral-400 disabled:opacity-60";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {mode === "signup" ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Full name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            placeholder="Morgan Patel"
            required
            autoComplete="name"
            disabled={isPending}
            className={fieldClass}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          placeholder="you@company.com"
          required
          autoComplete="email"
          disabled={isPending}
          className={fieldClass}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          placeholder={mode === "signup" ? "Minimum 8 characters" : "Enter your password"}
          required
          minLength={mode === "signup" ? 8 : undefined}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          disabled={isPending}
          className={fieldClass}
        />
      </div>

      {mode === "signup" ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="confirmPassword" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Confirm password
          </label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="Re-enter your password"
            required
            autoComplete="new-password"
            disabled={isPending}
            className={fieldClass}
          />
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
        >
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center gap-2 rounded-md bg-neutral-900 dark:bg-neutral-100 px-4 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {isPending
          ? mode === "signup"
            ? "Creating account…"
            : "Signing in…"
          : mode === "signup"
            ? "Create account"
            : "Sign in"}
      </button>

      <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
        {mode === "signup" ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-neutral-800 underline dark:text-neutral-200">
              Sign in
            </Link>
          </>
        ) : (
          <>
            Need an account?{" "}
            <Link href="/signup" className="font-medium text-neutral-800 underline dark:text-neutral-200">
              Create one
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
