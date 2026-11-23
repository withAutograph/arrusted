"use server";
import { revalidatePath } from "next/cache";
import {
  applyRecordImport,
  prepareRecordImport,
  type RecordImport,
} from "@autograph/work-session-tools/records";
import { definition, withActionData } from "../../app/data/canvas";

function validationFailure(error: unknown): { error: string } {
  if (error && typeof error === "object" && "envelope" in error) {
    const envelope = error.envelope as {
      code?: string;
      message?: string;
      details?: { message?: string }[];
    };
    if (
      [
        "contract_validation_failed",
        "record_target_missing",
        "schema_drift",
        "stale_base",
      ].includes(envelope.code ?? "")
    ) {
      return {
        error:
          [envelope.message, ...(envelope.details ?? []).map((detail) => detail.message)]
            .filter(Boolean)
            .join(" ") || "Check the record values and preview again.",
      };
    }
  }
  throw error;
}

export async function previewRecords(input: RecordImport, mode: "mainline" | "draft") {
  if (mode !== "mainline" && mode !== "draft") throw new Error("Choose how to save the records.");
  return withActionData(async (context) => {
    let prepared;
    try {
      prepared = prepareRecordImport(definition, input);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Check the record values." };
    }
    try {
      const result = await applyRecordImport(definition, context, prepared.input, {
        preview: true,
        mode,
      });
      return { ...result, input: prepared.input };
    } catch (error) {
      return validationFailure(error);
    }
  });
}

export async function saveRecords(
  input: RecordImport,
  mode: "mainline" | "draft",
  schemaRevisionId: string,
) {
  if (
    (mode !== "mainline" && mode !== "draft") ||
    typeof schemaRevisionId !== "string" ||
    !/^\d+$/.test(schemaRevisionId)
  )
    throw new Error("Preview the records before saving.");
  let receipt;
  try {
    receipt = await withActionData((context) =>
      applyRecordImport(definition, context, input, { mode, schemaRevisionId }),
    );
  } catch (error) {
    return validationFailure(error);
  }
  revalidatePath("/", "layout");
  return receipt;
}
