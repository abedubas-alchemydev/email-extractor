import { betterAuth } from "better-auth";
import { Pool } from "pg";

const globalForDb = globalThis as typeof globalThis & { __eePool?: Pool };
const database = globalForDb.__eePool ?? new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== "production") globalForDb.__eePool = database;

const appUrl = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const extraTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
  .split(",").map((o) => o.trim()).filter(Boolean);

export const auth = betterAuth({
  database,
  baseURL: appUrl,
  basePath: "/api/auth",
  trustedOrigins: [process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", "http://127.0.0.1:3000", ...extraTrustedOrigins],
  emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
  user: { fields: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" } },
  session: {
    expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24,
    fields: { userId: "user_id", expiresAt: "expires_at", ipAddress: "ip_address", userAgent: "user_agent", createdAt: "created_at", updatedAt: "updated_at" },
  },
  account: {
    fields: { userId: "user_id", accountId: "account_id", providerId: "provider_id", accessToken: "access_token", refreshToken: "refresh_token", accessTokenExpiresAt: "access_token_expires_at", refreshTokenExpiresAt: "refresh_token_expires_at", idToken: "id_token", createdAt: "created_at", updatedAt: "updated_at" },
  },
  verification: { fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" } },
  advanced: { useSecureCookies: process.env.ENVIRONMENT === "production" },
  secret: process.env.BETTER_AUTH_SECRET,
});
