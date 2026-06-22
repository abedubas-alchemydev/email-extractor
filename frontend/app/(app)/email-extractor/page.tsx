"use client";

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mail,
  Phone,
  Search,
  Sparkles,
  Square,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";

// --- Types (mirror backend/app/schemas/email_extractor.py) -----------------

type RunStatus = "queued" | "running" | "completed" | "failed";
type EnrichmentStatus = "not_enriched" | "enriched" | "no_match" | "error";

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
  enriched_name: string | null;
  enriched_title: string | null;
  enriched_linkedin_url: string | null;
  enriched_company: string | null;
  enriched_email: string | null;
  enriched_phone: string | null;
  enriched_at: string | null;
  enrichment_status: EnrichmentStatus;
  // True while an async Apollo phone-reveal callback is still expected, so the
  // row UI can poll for the number without polling forever.
  phone_reveal_pending?: boolean;
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
  enrich_cancelled_at: string | null;
  discovered_emails: DiscoveredEmailResponse[];
}

interface VerifyResultItem {
  email_id: number;
  email: string | null;
  smtp_status: string;
  smtp_message: string | null;
  checked_at: string;
}

interface VerificationRunCreateResponse {
  verify_run_id: number;
  status: RunStatus;
}

interface VerificationRunResponse {
  id: number;
  status: RunStatus;
  total_items: number;
  processed_items: number;
  success_count: number;
  failure_count: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  results: VerifyResultItem[];
}

interface EnrichAllResponse {
  scan_id: number;
  candidates_total: number;
  candidates_skipped_already_enriched: number;
  candidates_queued: number;
  status: "queued";
}

// --- Constants -------------------------------------------------------------

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 180_000;

// Phone-reveal poll (post-enrich): Apollo reveals the number asynchronously via
// webhook, so refetch the scan on a short cadence until it lands or the backend
// TTL clears the pending flag. Bounded so a never-resolving reveal stops.
const PHONE_REVEAL_POLL_MS = 3000;
const PHONE_REVEAL_TIMEOUT_MS = 240_000;

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed"]);

const STATUS_STYLES: Record<
  string,
  { className: string; Icon: typeof CheckCircle2; label: string }
> = {
  deliverable: { className: "text-green-600 bg-green-50", Icon: CheckCircle2, label: "Deliverable" },
  undeliverable: { className: "text-red-600 bg-red-50", Icon: XCircle, label: "Undeliverable" },
  inconclusive: { className: "text-amber-600 bg-amber-50", Icon: AlertCircle, label: "Inconclusive" },
  blocked: { className: "text-gray-600 bg-gray-100", Icon: AlertCircle, label: "Blocked" },
};

// --- API wrappers ----------------------------------------------------------

function getScan(scanId: number): Promise<ScanResponse> {
  return api<ScanResponse>(`/api/v1/email-extractor/scans/${scanId}`);
}

function enrichEmail(emailId: number): Promise<DiscoveredEmailResponse> {
  return api<DiscoveredEmailResponse>(
    `/api/v1/email-extractor/discovered-emails/${emailId}/enrich`,
    { method: "POST" },
  );
}

function enrichAll(scanId: number): Promise<EnrichAllResponse> {
  return api<EnrichAllResponse>(`/api/v1/email-extractor/scans/${scanId}/enrich-all`, {
    method: "POST",
  });
}

function cancelEnrichAll(scanId: number): Promise<ScanResponse> {
  return api<ScanResponse>(`/api/v1/email-extractor/scans/${scanId}/enrich-all/cancel`, {
    method: "POST",
  });
}

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

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Per-cause copy for a failed per-row enrich. 503 = not configured (expected
// when no provider keys are set), 502 = upstream unreachable, 404 = stale row.
function enrichErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503) return "Enrichment isn't configured — contact an admin.";
    if (err.status === 502) return "Couldn't reach the enrichment service — try again.";
    if (err.status === 404) return "This email no longer exists — refresh the scan.";
  }
  return errorMessage(err, "Couldn't enrich — please try again.");
}

function latestVerification(
  fromPoll: EmailVerificationResponse[],
  fromLocal: EmailVerificationResponse | undefined,
): EmailVerificationResponse | undefined {
  const candidates: EmailVerificationResponse[] = [...fromPoll];
  if (fromLocal) candidates.push(fromLocal);
  if (candidates.length === 0) return undefined;
  return candidates.reduce((latest, current) =>
    new Date(current.checked_at) > new Date(latest.checked_at) ? current : latest,
  );
}

// --- Sub-components --------------------------------------------------------

function StatusPill({ status }: { status: string }): React.ReactElement | null {
  const cfg = STATUS_STYLES[status];
  if (!cfg) return null;
  const { className, Icon, label } = cfg;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${className}`}
      aria-label={`Email ${status}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function VerifyButton({
  emailId,
  inFlight,
  onClick,
  error,
}: {
  emailId: number;
  inFlight: boolean;
  onClick: (emailId: number) => void;
  error: string | undefined;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => onClick(emailId)}
        disabled={inFlight}
        aria-label="Verify email deliverability"
        className="inline-flex items-center gap-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-0.5 text-xs font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {inFlight ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {inFlight ? "Verifying…" : "Verify"}
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}

function VerificationCell({
  row,
  localVerification,
  inFlight,
  verifyError,
  onVerify,
}: {
  row: DiscoveredEmailResponse;
  localVerification: EmailVerificationResponse | undefined;
  inFlight: boolean;
  verifyError: string | undefined;
  onVerify: (emailId: number) => void;
}): React.ReactElement {
  const latest = latestVerification(row.verifications, localVerification);

  // Definitive SMTP verdict — render the pill.
  if (latest && latest.smtp_status !== "not_checked") {
    return <StatusPill status={latest.smtp_status} />;
  }

  // No SMTP verdict yet — show inline syntax/MX summary + Verify button.
  const syntaxOk = latest?.syntax_valid === true;
  const mxOk = latest?.mx_record_present === true;
  return (
    <div className="flex flex-col items-start gap-1">
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
      <VerifyButton emailId={row.id} inFlight={inFlight} onClick={onVerify} error={verifyError} />
    </div>
  );
}

function EnrichButton({
  emailId,
  inFlight,
  label,
  onClick,
}: {
  emailId: number;
  inFlight: boolean;
  label: string;
  onClick: (emailId: number) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onClick(emailId)}
      disabled={inFlight}
      aria-label="Enrich the person behind this email"
      className="inline-flex items-center gap-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-0.5 text-xs font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {inFlight ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {inFlight ? "Enriching…" : label}
    </button>
  );
}

// Renders the enriched person (name/title/company) plus LinkedIn / alternate
// email / phone channel links. Each channel greys out when absent. The async
// Apollo phone reveal keeps a "finding phone…" signal until the number lands.
function EnrichedDetails({ row }: { row: DiscoveredEmailResponse }): React.ReactElement {
  // Only surface a revealed email when it's genuinely different from the
  // discovered address (which already lives in the Email column).
  const revealedEmail =
    row.enriched_email && row.enriched_email !== row.email ? row.enriched_email : null;
  const showPhonePending = !!row.phone_reveal_pending && !row.enriched_phone;

  const channelBase = "inline-flex items-center gap-1";
  const present = "text-neutral-700 dark:text-neutral-200 hover:underline";
  const absent = "text-neutral-300 dark:text-neutral-600 cursor-default";

  return (
    <div className="flex flex-col items-start gap-1 text-xs">
      {row.enriched_name ? (
        <span className="font-semibold text-neutral-800 dark:text-neutral-100">{row.enriched_name}</span>
      ) : null}
      {row.enriched_title ? (
        <span className="text-neutral-600 dark:text-neutral-300">{row.enriched_title}</span>
      ) : null}
      {row.enriched_company ? (
        <span className="text-neutral-500 dark:text-neutral-400">{row.enriched_company}</span>
      ) : null}
      <span className="mt-0.5 inline-flex items-center gap-3">
        {/* lucide-react 1.x dropped brand glyphs, so the LinkedIn channel uses a
            recognizable "in" text badge rather than a generic icon. */}
        {row.enriched_linkedin_url ? (
          <a
            href={row.enriched_linkedin_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] bg-[#0a66c2] text-[9px] font-bold leading-none text-white hover:opacity-80"
            aria-label="LinkedIn profile"
            title="LinkedIn profile"
          >
            in
          </a>
        ) : (
          <span
            className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] bg-neutral-200 text-[9px] font-bold leading-none text-neutral-400 dark:bg-neutral-700 dark:text-neutral-500"
            aria-label="No LinkedIn profile"
            title="No LinkedIn profile"
          >
            in
          </span>
        )}
        {revealedEmail ? (
          <a
            href={`mailto:${revealedEmail}`}
            className={`${channelBase} ${present}`}
            aria-label={`Alternate email ${revealedEmail}`}
          >
            <Mail className="h-3.5 w-3.5" />
          </a>
        ) : (
          <span className={`${channelBase} ${absent}`} aria-label="No alternate email">
            <Mail className="h-3.5 w-3.5" />
          </span>
        )}
        {row.enriched_phone ? (
          <a
            href={`tel:${row.enriched_phone}`}
            className={`${channelBase} ${present}`}
            aria-label={`Phone ${row.enriched_phone}`}
          >
            <Phone className="h-3.5 w-3.5" />
            <span className="tabular-nums">{row.enriched_phone}</span>
          </a>
        ) : (
          <span className={`${channelBase} ${absent}`} aria-label="No phone">
            <Phone className="h-3.5 w-3.5" />
          </span>
        )}
      </span>
      {showPhonePending ? (
        <span className="inline-flex items-center gap-1 text-neutral-500 dark:text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          finding phone…
        </span>
      ) : null}
    </div>
  );
}

function EnrichmentCell({
  row,
  inFlight,
  error,
  onEnrich,
}: {
  row: DiscoveredEmailResponse;
  inFlight: boolean;
  error: string | undefined;
  onEnrich: (emailId: number) => void;
}): React.ReactElement {
  if (row.enrichment_status === "enriched") {
    return <EnrichedDetails row={row} />;
  }

  // no_match / error / not_enriched all get a (re-)run affordance. The label
  // signals which state the row is in.
  const label =
    row.enrichment_status === "no_match"
      ? "Re-enrich"
      : row.enrichment_status === "error"
        ? "Retry"
        : "Enrich";

  return (
    <div className="flex flex-col items-start gap-1">
      {row.enrichment_status === "no_match" ? (
        <span className="text-xs text-neutral-500 dark:text-neutral-400">Not found</span>
      ) : null}
      {row.enrichment_status === "error" ? (
        <span className="inline-flex items-center gap-1 text-xs text-red-600">
          <AlertCircle className="h-3.5 w-3.5" />
          Error
        </span>
      ) : null}
      <EnrichButton emailId={row.id} inFlight={inFlight} label={label} onClick={onEnrich} />
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}

function ResultsTable({
  rows,
  localVerifications,
  verifyInFlight,
  verifyErrors,
  onVerify,
  enrichInFlight,
  enrichErrors,
  onEnrich,
}: {
  rows: DiscoveredEmailResponse[];
  localVerifications: Record<number, EmailVerificationResponse>;
  verifyInFlight: Set<number>;
  verifyErrors: Record<number, string>;
  onVerify: (emailId: number) => void;
  enrichInFlight: Set<number>;
  enrichErrors: Record<number, string>;
  onEnrich: (emailId: number) => void;
}): React.ReactElement {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-6 py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
        <Mail className="mx-auto mb-2 h-5 w-5 opacity-50" />
        No emails found yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 dark:bg-neutral-900 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-4 py-2 font-medium">Email</th>
            <th className="px-4 py-2 font-medium">Source</th>
            <th className="px-4 py-2 font-medium">Confidence</th>
            <th className="px-4 py-2 font-medium">Enrichment</th>
            <th className="px-4 py-2 font-medium">Verification</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map((row) => (
            <tr key={row.id} className="align-top">
              <td className="px-4 py-2 font-mono text-xs">{row.email}</td>
              <td className="px-4 py-2 text-xs text-neutral-600 dark:text-neutral-400">{row.source}</td>
              <td className="px-4 py-2 text-xs tabular-nums">{formatConfidence(row.confidence)}</td>
              <td className="px-4 py-2">
                <EnrichmentCell
                  row={row}
                  inFlight={enrichInFlight.has(row.id)}
                  error={enrichErrors[row.id]}
                  onEnrich={onEnrich}
                />
              </td>
              <td className="px-4 py-2">
                <VerificationCell
                  row={row}
                  localVerification={localVerifications[row.id]}
                  inFlight={verifyInFlight.has(row.id)}
                  verifyError={verifyErrors[row.id]}
                  onVerify={onVerify}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "Enrich all" headline action: enqueues per-row enrichment for every
// unenriched email, then polls the scan for progress. Mirrors the per-row
// affordances so the whole table can be filled in one click, with a Stop that
// keeps rows already extracted.
function EnrichAllControl({
  scanId,
  unenrichedCount,
  onProgress,
}: {
  scanId: number;
  unenrichedCount: number;
  onProgress: () => void;
}): React.ReactElement {
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const mountedRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const handleClick = useCallback(async () => {
    if (isRunning || unenrichedCount <= 0) return;
    setIsRunning(true);
    setIsStopping(false);
    setStatusText(`Enriching ${unenrichedCount}…`);
    pollCountRef.current = 0;

    let queued: EnrichAllResponse;
    try {
      queued = await enrichAll(scanId);
    } catch (err) {
      if (!mountedRef.current) return;
      setIsRunning(false);
      setStatusText(enrichErrorMessage(err));
      return;
    }
    if (!mountedRef.current) return;

    if (queued.candidates_queued === 0) {
      setIsRunning(false);
      setStatusText("Nothing to enrich — all rows already processed.");
      return;
    }
    setStatusText(`Enriching ${queued.candidates_queued}…`);

    pollRef.current = setInterval(async () => {
      if (!mountedRef.current) {
        stopPolling();
        return;
      }
      pollCountRef.current += 1;
      try {
        const scan = await getScan(scanId);
        onProgress();
        const total = scan.discovered_emails.length;
        let enriched = 0;
        let failed = 0;
        for (const r of scan.discovered_emails) {
          if (r.enrichment_status === "enriched") enriched += 1;
          else if (r.enrichment_status === "no_match" || r.enrichment_status === "error") failed += 1;
        }
        const cancelled = scan.enrich_cancelled_at !== null;
        const failedSuffix = failed > 0 ? `, ${failed} failed` : "";

        if (cancelled) {
          stopPolling();
          if (!mountedRef.current) return;
          setIsRunning(false);
          setIsStopping(false);
          setStatusText(`Stopped — kept ${enriched} of ${total}${failedSuffix}.`);
          return;
        }
        if (enriched + failed >= total) {
          stopPolling();
          if (!mountedRef.current) return;
          setIsRunning(false);
          setStatusText(`Done — enriched ${enriched} of ${total}${failedSuffix}.`);
          return;
        }
        setStatusText(`Enriched ${enriched} of ${total}${failedSuffix}…`);

        // ~5 minutes of 3s polls; stop and let the user refresh if it overruns.
        if (pollCountRef.current >= 100) {
          stopPolling();
          if (!mountedRef.current) return;
          setIsRunning(false);
          setStatusText("Still enriching — refresh to see the latest.");
        }
      } catch {
        stopPolling();
        if (!mountedRef.current) return;
        setIsRunning(false);
        setIsStopping(false);
        setStatusText("Lost connection while polling — please try again.");
      }
    }, PHONE_REVEAL_POLL_MS);
  }, [isRunning, onProgress, scanId, stopPolling, unenrichedCount]);

  const handleStop = useCallback(async () => {
    if (!isRunning || isStopping) return;
    setIsStopping(true);
    setStatusText("Stopping…");
    try {
      await cancelEnrichAll(scanId);
    } catch {
      if (!mountedRef.current) return;
      setIsStopping(false);
      setStatusText("Couldn't stop enrichment — please try again.");
    }
  }, [isRunning, isStopping, scanId]);

  const disabled = isRunning || unenrichedCount <= 0;
  const label = isRunning ? `Enriching ${unenrichedCount}…` : "Enrich all";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleClick()}
          disabled={disabled}
          aria-busy={isRunning}
          title={!isRunning && unenrichedCount <= 0 ? "All discovered emails already enriched" : undefined}
          className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-3 py-1.5 text-xs font-medium hover:bg-neutral-700 dark:hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {label}
        </button>
        {isRunning ? (
          <button
            type="button"
            onClick={() => void handleStop()}
            disabled={isStopping}
            aria-label="Stop enrichment"
            title="Stop enrichment — keeps rows already extracted"
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Square className="h-3.5 w-3.5" />
            {isStopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>
      {statusText !== null ? (
        <span className="text-xs text-neutral-500 dark:text-neutral-400" aria-live="polite">
          {statusText}
        </span>
      ) : null}
    </div>
  );
}

// --- Page ------------------------------------------------------------------

export default function EmailExtractorPage(): React.ReactElement {
  const [domain, setDomain] = useState("");
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [localVerifications, setLocalVerifications] = useState<Record<number, EmailVerificationResponse>>({});
  const [verifyInFlight, setVerifyInFlight] = useState<Set<number>>(new Set());
  const [verifyErrors, setVerifyErrors] = useState<Record<number, string>>({});
  const [enrichInFlight, setEnrichInFlight] = useState<Set<number>>(new Set());
  const [enrichErrors, setEnrichErrors] = useState<Record<number, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const verifyPollsRef = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map());
  const enrichPollsRef = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map());

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const stopVerifyPoll = useCallback((emailId: number) => {
    const handle = verifyPollsRef.current.get(emailId);
    if (handle !== undefined) {
      clearInterval(handle);
      verifyPollsRef.current.delete(emailId);
    }
  }, []);

  const stopAllVerifyPolls = useCallback(() => {
    verifyPollsRef.current.forEach((handle) => clearInterval(handle));
    verifyPollsRef.current.clear();
  }, []);

  const stopEnrichPoll = useCallback((emailId: number) => {
    const handle = enrichPollsRef.current.get(emailId);
    if (handle !== undefined) {
      clearInterval(handle);
      enrichPollsRef.current.delete(emailId);
    }
  }, []);

  const stopAllEnrichPolls = useCallback(() => {
    enrichPollsRef.current.forEach((handle) => clearInterval(handle));
    enrichPollsRef.current.clear();
  }, []);

  useEffect(
    () => () => {
      stopPolling();
      stopAllVerifyPolls();
      stopAllEnrichPolls();
    },
    [stopPolling, stopAllVerifyPolls, stopAllEnrichPolls],
  );

  const isInFlight = scan !== null && !TERMINAL_STATUSES.has(scan.status) && !timedOut;
  const unenrichedCount =
    scan?.discovered_emails.filter((row) => row.enrichment_status !== "enriched").length ?? 0;

  const finishVerify = useCallback(
    (emailId: number, result: VerifyResultItem | undefined, failureMessage: string | null) => {
      stopVerifyPoll(emailId);
      if (result) {
        const verification: EmailVerificationResponse = {
          id: -1, // synthetic — display cell keys off smtp_status, not id
          syntax_valid: null,
          mx_record_present: null,
          smtp_status: result.smtp_status,
          smtp_message: result.smtp_message,
          checked_at: result.checked_at,
        };
        setLocalVerifications((prev) => ({ ...prev, [emailId]: verification }));
      }
      if (failureMessage !== null) {
        setVerifyErrors((prev) => ({ ...prev, [emailId]: failureMessage }));
      }
      setVerifyInFlight((prev) => {
        const next = new Set(prev);
        next.delete(emailId);
        return next;
      });
    },
    [stopVerifyPoll],
  );

  const handleVerify = useCallback(
    async (emailId: number) => {
      stopVerifyPoll(emailId);
      setVerifyInFlight((prev) => {
        const next = new Set(prev);
        next.add(emailId);
        return next;
      });
      setVerifyErrors((prev) => {
        if (!(emailId in prev)) return prev;
        const next = { ...prev };
        delete next[emailId];
        return next;
      });

      let verifyRunId: number;
      try {
        const created = await api<VerificationRunCreateResponse>(
          "/api/v1/email-extractor/verify",
          {
            method: "POST",
            body: JSON.stringify({ email_ids: [emailId] }),
          },
        );
        verifyRunId = created.verify_run_id;
      } catch (err) {
        finishVerify(emailId, undefined, errorMessage(err, "verification failed"));
        return;
      }

      const startedAt = Date.now();
      const handle = setInterval(async () => {
        try {
          const run = await api<VerificationRunResponse>(
            `/api/v1/email-extractor/verify-runs/${verifyRunId}`,
          );
          if (TERMINAL_STATUSES.has(run.status)) {
            const result = run.results.find((r) => r.email_id === emailId);
            const failure = run.status === "failed" ? run.error_message ?? "verification failed" : null;
            finishVerify(emailId, result, failure);
            return;
          }
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            finishVerify(emailId, undefined, "verification timed out");
          }
        } catch (pollErr) {
          finishVerify(emailId, undefined, errorMessage(pollErr, "verification failed"));
        }
      }, POLL_INTERVAL_MS);
      verifyPollsRef.current.set(emailId, handle);
    },
    [finishVerify, stopVerifyPoll],
  );

  const startPhoneRevealPoll = useCallback(
    (emailId: number) => {
      if (scan === null) return;
      const scanId = scan.id;
      stopEnrichPoll(emailId);
      const startedAt = Date.now();
      const handle = setInterval(async () => {
        if (Date.now() - startedAt > PHONE_REVEAL_TIMEOUT_MS) {
          stopEnrichPoll(emailId);
          return;
        }
        try {
          const next = await getScan(scanId);
          setScan(next);
          const row = next.discovered_emails.find((r) => r.id === emailId);
          if (!row || row.enriched_phone !== null || !row.phone_reveal_pending) {
            stopEnrichPoll(emailId);
          }
        } catch {
          stopEnrichPoll(emailId);
        }
      }, PHONE_REVEAL_POLL_MS);
      enrichPollsRef.current.set(emailId, handle);
    },
    [scan, stopEnrichPoll],
  );

  const handleEnrich = useCallback(
    async (emailId: number) => {
      setEnrichInFlight((prev) => {
        const next = new Set(prev);
        next.add(emailId);
        return next;
      });
      setEnrichErrors((prev) => {
        if (!(emailId in prev)) return prev;
        const next = { ...prev };
        delete next[emailId];
        return next;
      });

      try {
        const updated = await enrichEmail(emailId);
        setScan((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                discovered_emails: prev.discovered_emails.map((row) =>
                  row.id === emailId ? updated : row,
                ),
              },
        );
        if (updated.phone_reveal_pending) {
          startPhoneRevealPoll(emailId);
        }
      } catch (err) {
        setEnrichErrors((prev) => ({ ...prev, [emailId]: enrichErrorMessage(err) }));
      } finally {
        setEnrichInFlight((prev) => {
          const next = new Set(prev);
          next.delete(emailId);
          return next;
        });
      }
    },
    [startPhoneRevealPoll],
  );

  // Drive a refetch from the "Enrich all" progress poll without re-mounting it.
  const refetchScan = useCallback(async () => {
    if (scan === null) return;
    try {
      setScan(await getScan(scan.id));
    } catch {
      // Transient blips are surfaced by the control's own status line.
    }
  }, [scan]);

  // Resume phone-reveal polls for any row that's still pending after a refetch
  // (e.g. an Enrich-all run revealed phones asynchronously). Skip ids already
  // polling so we never stack duplicate intervals.
  useEffect(() => {
    if (scan === null) return;
    for (const row of scan.discovered_emails) {
      if (row.phone_reveal_pending && !row.enriched_phone && !enrichPollsRef.current.has(row.id)) {
        startPhoneRevealPoll(row.id);
      }
    }
  }, [scan, startPhoneRevealPoll]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = normalizeDomain(domain);
    if (!cleaned) return;

    stopPolling();
    stopAllVerifyPolls();
    stopAllEnrichPolls();
    setError(null);
    setTimedOut(false);
    setScan(null);
    // Reset per-row state for the new scan.
    setLocalVerifications({});
    setVerifyInFlight(new Set());
    setVerifyErrors({});
    setEnrichInFlight(new Set());
    setEnrichErrors({});

    try {
      const created = await api<ScanResponse>("/api/v1/email-extractor/scans", {
        method: "POST",
        body: JSON.stringify({ domain: cleaned }),
      });
      setScan(created);
      startedAtRef.current = Date.now();

      pollRef.current = setInterval(async () => {
        try {
          const next = await getScan(created.id);
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
          setError(errorMessage(pollErr, "polling failed"));
        }
      }, POLL_INTERVAL_MS);
    } catch (submitErr) {
      setError(errorMessage(submitErr, "request failed"));
    }
  };

  // Empty state -> vertically centered like a search landing page.
  const hasContent = scan !== null || error !== null || timedOut;

  return (
    <main className="flex flex-col items-center px-4">
      <div className={`w-full max-w-4xl ${hasContent ? "mt-16 mb-16" : "my-24 py-12"}`}>
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
            aria-label="Domain to scan"
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
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-neutral-600 dark:text-neutral-400">
            {isInFlight && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>
              Status:{" "}
              <span className="font-medium text-neutral-800 dark:text-neutral-200">{scan.status}</span>
            </span>
            {scan.total_items > 0 && (
              <span className="tabular-nums">
                {scan.processed_items} / {scan.total_items}
              </span>
            )}
            {scan.error_message && <span className="text-rose-600">{scan.error_message}</span>}
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
            {scan.discovered_emails.length > 0 && (
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Discovered emails
                </h2>
                <EnrichAllControl
                  scanId={scan.id}
                  unenrichedCount={unenrichedCount}
                  onProgress={() => void refetchScan()}
                />
              </div>
            )}
            <ResultsTable
              rows={scan.discovered_emails}
              localVerifications={localVerifications}
              verifyInFlight={verifyInFlight}
              verifyErrors={verifyErrors}
              onVerify={handleVerify}
              enrichInFlight={enrichInFlight}
              enrichErrors={enrichErrors}
              onEnrich={handleEnrich}
            />
          </section>
        )}
      </div>
    </main>
  );
}
