"use client";

import { AlertCircle, CheckCircle2, Loader2, Mail, Search, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";

// --- Types (mirror backend/app/schemas/email_extractor.py) -----------------

type RunStatus = "queued" | "running" | "completed" | "failed";

interface EmailVerificationResponse {
  id: number;
  syntax_valid: boolean | null;
  mx_record_present: boolean | null;
  smtp_status: string;
  smtp_message: string | null;
  checked_at: string;
}

interface DiscoveredEmailResponse {
  id: number;
  email: string;
  domain: string;
  source: string;
  confidence: number | null;
  attribution: string | null;
  created_at: string;
  verifications: EmailVerificationResponse[];
}

interface ScanResponse {
  id: number;
  pipeline_name: string;
  domain: string;
  person_name: string | null;
  status: RunStatus;
  total_items: number;
  processed_items: number;
  success_count: number;
  failure_count: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  discovered_emails: DiscoveredEmailResponse[];
}

// --- Constants -------------------------------------------------------------

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 180_000;

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed"]);

// --- Helpers ---------------------------------------------------------------

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function formatConfidence(c: number | null): string {
  if (c === null || Number.isNaN(c)) return "—";
  return `×${c.toFixed(2)}`;
}

// --- Sub-components --------------------------------------------------------

function VerificationCell({ row }: { row: DiscoveredEmailResponse }): React.ReactElement {
  const v = row.verifications[0];
  if (v && v.smtp_status !== "not_checked") {
    const ok = v.smtp_status === "deliverable";
    const Icon = ok ? CheckCircle2 : XCircle;
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <Icon className={ok ? "h-4 w-4 text-emerald-600" : "h-4 w-4 text-rose-600"} />
        {v.smtp_status}
      </span>
    );
  }
  const syntaxOk = v?.syntax_valid === true;
  const mxOk = v?.mx_record_present === true;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
      <span className="inline-flex items-center gap-1">
        {syntaxOk ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-neutral-400" />
        )}
        syntax
      </span>
      <span className="inline-flex items-center gap-1">
        {mxOk ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-neutral-400" />
        )}
        MX
      </span>
    </span>
  );
}

function ResultsTable({ rows }: { rows: DiscoveredEmailResponse[] }): React.ReactElement {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-6 py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
        <Mail className="mx-auto mb-2 h-5 w-5 opacity-50" />
        No emails found yet.
        <div className="mt-1 text-xs opacity-75">
          Provider integrations land in follow-up prompts; today the aggregator stub returns nothing.
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 dark:bg-neutral-900 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-4 py-2 font-medium">Email</th>
            <th className="px-4 py-2 font-medium">Source</th>
            <th className="px-4 py-2 font-medium">Confidence</th>
            <th className="px-4 py-2 font-medium">Verification</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-2 font-mono text-xs">{row.email}</td>
              <td className="px-4 py-2 text-xs text-neutral-600 dark:text-neutral-400">{row.source}</td>
              <td className="px-4 py-2 text-xs tabular-nums">{formatConfidence(row.confidence)}</td>
              <td className="px-4 py-2">
                <VerificationCell row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Page ------------------------------------------------------------------

export default function Home(): React.ReactElement {
  const [domain, setDomain] = useState("");
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const isInFlight = scan !== null && !TERMINAL_STATUSES.has(scan.status) && !timedOut;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = normalizeDomain(domain);
    if (!cleaned) return;

    stopPolling();
    setError(null);
    setTimedOut(false);
    setScan(null);

    try {
      const created = await api<ScanResponse>("/api/v1/email-extractor/scans", {
        method: "POST",
        body: JSON.stringify({ domain: cleaned }),
      });
      setScan(created);
      startedAtRef.current = Date.now();

      pollRef.current = setInterval(async () => {
        try {
          const next = await api<ScanResponse>(`/api/v1/email-extractor/scans/${created.id}`);
          setScan(next);
          if (TERMINAL_STATUSES.has(next.status)) {
            stopPolling();
            return;
          }
          if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
            stopPolling();
            setTimedOut(true);
          }
        } catch (pollErr) {
          stopPolling();
          setError(pollErr instanceof ApiError ? pollErr.message : "polling failed");
        }
      }, POLL_INTERVAL_MS);
    } catch (submitErr) {
      setError(submitErr instanceof ApiError ? submitErr.message : "request failed");
    }
  };

  // Empty state -> vertically centered like a search landing page.
  // Once we have a scan in flight or any returned data, top-align so the form
  // stays visible while the table grows below it.
  const hasContent = scan !== null || error !== null || timedOut;

  return (
    <main className="min-h-screen flex flex-col items-center px-4">
      <div className={`w-full max-w-3xl ${hasContent ? "mt-24 mb-16" : "my-auto py-12"}`}>
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">Email Extractor</h1>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            Find every email address associated with a domain.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          placeholder="alchemydev.io"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={isInFlight}
          className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm font-mono shadow-sm focus:outline-none focus:ring-2 focus:ring-neutral-400 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={isInFlight || domain.trim().length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Search className="h-4 w-4" />
          Search
        </button>
      </form>

      {scan !== null && (
        <div className="mt-4 flex items-center gap-3 text-xs text-neutral-600 dark:text-neutral-400">
          {isInFlight && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>
            Status: <span className="font-medium text-neutral-800 dark:text-neutral-200">{scan.status}</span>
          </span>
          {scan.total_items > 0 && (
            <span className="tabular-nums">
              {scan.processed_items} / {scan.total_items}
            </span>
          )}
          <span className="ml-auto font-mono">scan #{scan.id}</span>
        </div>
      )}

      {timedOut && (
        <div className="mt-4 inline-flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>Still running after 3 minutes. Check back later — refresh the page to resume polling.</span>
        </div>
      )}

      {error !== null && (
        <div className="mt-4 inline-flex items-start gap-2 text-xs text-rose-700 dark:text-rose-400">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

        {scan !== null && (
          <section className="mt-8">
            <ResultsTable rows={scan.discovered_emails} />
          </section>
        )}
      </div>
    </main>
  );
}
