import Link from "next/link";

// App-level 404: any bad URL lands here with a way back in, instead of Next's
// dead-end default. Static markup only: no data access, no client JS.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600 dark:text-indigo-400">
        404
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">
        There&apos;s nothing at this address
      </h1>
      <p className="mt-2 text-sm leading-6 text-zinc-500">
        The link may be wrong or out of date.
      </p>
      <Link
        href="/console"
        className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm shadow-indigo-950/15 transition-colors hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
      >
        Open the Console
      </Link>
    </main>
  );
}
