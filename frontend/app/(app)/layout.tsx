import type { ReactNode } from "react";

import { LogoutButton } from "@/components/auth/logout-button";
import { getRequiredSession } from "@/lib/auth-server";

// Auth wall for the whole tool. getRequiredSession() redirects to /login when
// there's no valid session, so every route under the (app) group is gated on a
// signed-in user. Deliberately minimal — the parent's AppShell / ActivityProvider
// / SecurityShield are out of scope for the standalone carve-out. A thin header
// carries the signed-in identity + the sign-out control.
export default async function ProtectedAppLayout({ children }: { children: ReactNode }) {
  const session = await getRequiredSession();

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-end gap-3 border-b border-neutral-200 dark:border-neutral-800 px-4 py-2.5">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{session.user.email}</span>
        <LogoutButton />
      </header>
      {children}
    </div>
  );
}
