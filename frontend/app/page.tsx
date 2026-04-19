import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-xl text-center space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Email Extractor — scaffold ready
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Backend at <code className="font-mono">/api/v1/health</code>. Provider implementations,
          discovery aggregator, and the scan UI are added in follow-up prompts.
        </p>
        <Link
          href="/email-extractor"
          className="inline-block text-sm underline underline-offset-4 text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white"
        >
          Open the email-extractor route &rarr;
        </Link>
      </div>
    </main>
  );
}
