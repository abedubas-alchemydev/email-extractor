"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

// Signs the user out (clears the BetterAuth session cookie) and returns to
// /login. Rendered in the gated (app) layout so it's available on every tool
// page.
export function LogoutButton(): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSignOut(): Promise<void> {
    setPending(true);
    try {
      await authClient.signOut();
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleSignOut()}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <LogOut className="h-3.5 w-3.5" />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
