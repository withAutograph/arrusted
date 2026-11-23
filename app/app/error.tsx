"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="page">
      <h1>We could not open this page</h1>
      <p>Your session or data connection may be unavailable.</p>
      <button className="primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
