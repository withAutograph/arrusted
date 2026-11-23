import Link from "next/link";

export default function ExampleNextDetailsPage() {
  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">App-owned route</p>
        <h1>The shell did not coordinate this page</h1>
        <p className="lede">
          Next.js resolved this nested filesystem route and can prefetch its RSC
          payload because same-zone navigation uses the framework&apos;s Link
          component.
        </p>
        <Link className="primary-link" href="/">
          Return to the Next example
        </Link>
      </section>
    </main>
  );
}
