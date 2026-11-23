import { Suspense } from "react";
import { notFound } from "next/navigation";
import { canvas, definition } from "../../../data/canvas";
import { RecordEntry } from "../../../../features/records/record-entry";
import { CanvasWorkspace } from "../../../workspace/canvas";
async function Workspace({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const [session, viewer] = await Promise.all([canvas.sessions.get(sessionId), canvas.viewer()]);
  if (!session) notFound();
  return (
    <>
      <RecordEntry
        models={definition.models.filter((model) => session.models.includes(model.id))}
        initialDate={session.asOf}
      />
      <div className="canvas-shell">
        <CanvasWorkspace
          definition={definition}
          sessionId={sessionId}
          canApprove={viewer.canApprove}
        />
      </div>
    </>
  );
}
export default function Page(props: { params: Promise<{ sessionId: string }> }) {
  return (
    <Suspense fallback={<p>Loading canvas…</p>}>
      <Workspace {...props} />
    </Suspense>
  );
}
