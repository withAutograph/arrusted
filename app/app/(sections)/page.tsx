import { Suspense } from "react";
import Link from "next/link";
import { canvas, definition } from "../data/canvas";
import { NewSession } from "../workspace/new-session";
async function Sessions() {
  const sessions = await canvas.sessions.list();
  return (
    <div className="session-list">
      {sessions.length === 0 ? (
        <p>No sessions yet. Open a table to begin.</p>
      ) : (
        sessions.map((session) => (
          <Link key={session.id} href={`/starter/${session.id}`}>
            <strong>{session.title}</strong>
            <br />
            <small>As of {session.asOf}</small>
          </Link>
        ))
      )}
    </div>
  );
}
export default function Home() {
  return (
    <main className="page">
      <h1>Your tables</h1>
      <p>
        Open a table to work with records. Changes stay in a session until you review and save them.
      </p>
      <div className="table-links">
        {definition.models.map((model) => (
          <Link key={model.id} href={`/tables/${model.id}`}>
            {model.name}
          </Link>
        ))}
      </div>
      <NewSession title="All tables" />
      <h2>Recent sessions</h2>
      <Suspense fallback={<p>Loading sessions…</p>}>
        <Sessions />
      </Suspense>
    </main>
  );
}
