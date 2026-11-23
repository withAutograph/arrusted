"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createOperations } from "../../.generated/release/data-operations";
import { withActionData } from "../../app/data/canvas";

const fields = ["title", "body"] as const;
export async function createNote(form: FormData) {
  const requestId = form.get("requestId");
  const asOf = form.get("asOf");
  if (
    typeof requestId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(requestId) ||
    typeof asOf !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf)
  )
    throw new Error("Invalid note request.");
  let failed = false;
  await withActionData(async (context) => {
    const notes = createOperations(context).note;
    try {
      const parsed = notes.parseForm(form, { fields, mode: "create" });
      if (!parsed.values.title.trim()) {
        failed = true;
        return;
      }
      await notes.create(parsed.values, { effectiveStart: asOf, idempotencyKey: requestId });
    } catch (error) {
      if (!notes.toFormError(error, { fields })) throw error;
      failed = true;
    }
  });
  if (failed) redirect("/overview?error=invalid_note");
  revalidatePath("/overview");
  revalidatePath("/");
  redirect("/overview?created=1");
}
