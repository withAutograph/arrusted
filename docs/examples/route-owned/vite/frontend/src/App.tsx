import { nextExamplePath, RouterLink, useExampleRoute } from "./router";

export function App() {
  const route = useExampleRoute();

  if (route === "details") return <Details />;
  if (route === "not-found") return <NotFound />;

  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">Traditional Vite zone</p>
        <h1>A client app can own the route, too</h1>
        <p className="lede">
          This React SPA is independently built and served by the generic static-zone runner. The
          gateway forwards its mounted request unchanged; this app owns its history and document.
        </p>
        <RouterLink route="details">Open the client-routed details view</RouterLink>
        <a className="secondary-link" data-cross-application="document" href={nextExamplePath}>
          Open the Next example
        </a>
      </section>

      <section className="facts" aria-labelledby="facts-heading">
        <h2 id="facts-heading">No shell integration layer</h2>
        <ul>
          <li>Filesystem discovery derives the mount, assets, port, and service.</li>
          <li>Vite builds the app with its ordinary base-path adapter.</li>
          <li>The production runner provides history fallback without interpreting the UI.</li>
        </ul>
      </section>
    </main>
  );
}

function Details() {
  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">App-owned client route</p>
        <h1>The shell did not render this view</h1>
        <p className="lede">
          The app&apos;s tiny router handled this same-zone navigation. A production SPA can use its
          preferred client router without exporting routes to the platform.
        </p>
        <RouterLink route="home">Return to the Vite example</RouterLink>
      </section>
    </main>
  );
}

function NotFound() {
  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">App-owned not found</p>
        <h1>This Vite zone owns its errors</h1>
        <RouterLink route="home">Return to the Vite example</RouterLink>
      </section>
    </main>
  );
}
