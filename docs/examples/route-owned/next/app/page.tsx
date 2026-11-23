import Link from "next/link";
import { Link as MicrofrontendLink } from "@vercel/microfrontends/next/client";

import { Counter } from "./Counter";

const frameworkFacts = [
  "This page is rendered by its own Next.js server.",
  "Its App Router, layout, RSC payload, assets, and errors stay app-owned.",
  "The gateway forwards the complete mounted request without HTML rewriting.",
] as const;

export default function ExampleNextPage() {
  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">Native Next.js zone</p>
        <h1>Route ownership, with React Server Components</h1>
        <p className="lede">
          After this template is copied under <code>apps/&lt;name&gt;</code>, filesystem discovery
          installs it without exporting a component to the shell or declaring a manifest.
        </p>
        <Link className="primary-link" href="/details">
          Open the app-owned details route
        </Link>
        <MicrofrontendLink className="secondary-link" href="/example-vite">
          Open the Vite example
        </MicrofrontendLink>
      </section>

      <section className="facts" aria-labelledby="facts-heading">
        <h2 id="facts-heading">What remains native</h2>
        <ul>
          {frameworkFacts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </section>

      <Counter />
    </main>
  );
}
