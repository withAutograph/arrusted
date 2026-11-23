import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { definition } from "../../../data/canvas";
import { RecordEntry } from "../../../../features/records/record-entry";
import { NewSession } from "../../../workspace/new-session";
async function Table({ params }: { params: Promise<{ model: string }> }) {
  const { model: modelId } = await params;
  const model = definition.models.find((item) => item.id === modelId);
  if (!model) notFound();
  await connection();
  return (
    <main className="page">
      <h1>{model.name}</h1>
      <p>
        Open a Canvas session to view and edit this table, import CSV, and review changes before
        saving.
      </p>
      <NewSession title={model.name} models={[model.id]} />
      <RecordEntry models={[model]} initialDate={new Date().toISOString().slice(0, 10)} />
    </main>
  );
}
export default function Page(props: { params: Promise<{ model: string }> }) {
  return (
    <Suspense fallback={<p>Loading table…</p>}>
      <Table {...props} />
    </Suspense>
  );
}
