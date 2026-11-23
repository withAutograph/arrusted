import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import Link from "next/link";
import { canvas } from "../../data/canvas";
import { createNote } from "../../../features/notes/actions";
type Query = Promise<Record<string, string | string[] | undefined>>;
async function Overview({ searchParams }: { searchParams: Query }) {
  const sessions = await canvas.sessions.list();
  const query = await searchParams;
  const asOf = new Date().toISOString().slice(0, 10);
  return (
    <main className="page">
      <h1>Overview</h1>
      <p>
        You have {sessions.length} working {sessions.length === 1 ? "session" : "sessions"}. Each
        keeps its own date, scope and changes ready for review.
      </p>
      <h2>Add a note</h2>
      <p>
        This custom section saves a new note. Open Notes in Canvas to edit and review later changes.
      </p>
      {query.created === "1" && (
        <p role="status">Note saved. Open its table in Canvas to continue.</p>
      )}
      {query.error && (
        <p role="alert">The note could not be saved. Enter a title and valid text.</p>
      )}
      <form action={createNote} className="note-form">
        <input type="hidden" name="requestId" value={randomUUID()} />
        <label>
          As of
          <input name="asOf" type="date" value={asOf} readOnly />
        </label>
        <label>
          Title
          <input name="title" required maxLength={200} />
        </label>
        <label>
          Body
          <textarea name="body" rows={4} />
        </label>
        <button className="primary" type="submit">
          Save note
        </button>
      </form>
      <Link href="/tables/note">Open Notes</Link>
    </main>
  );
}
export default function Page(props: { searchParams: Query }) {
  return (
    <Suspense fallback={<p>Loading overview…</p>}>
      <Overview {...props} />
    </Suspense>
  );
}
