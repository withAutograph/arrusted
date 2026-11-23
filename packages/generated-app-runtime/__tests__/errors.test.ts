import { expect, test } from "vite-plus/test";
import type {
  FormActionResult,
  FormError,
  FormErrorCode,
} from "@autograph/generated-app-runtime/errors";

const code: FormErrorCode = "constraint_violation";
const titleOnly: FormError<"title"> = {
  ok: false,
  code,
  message: "A fixed browser-safe message",
  fieldErrors: {
    title: { code: "constraint_violation", message: "A fixed browser-safe message" },
  },
};
// @ts-expect-error FormError only exposes the supplied selected field names.
titleOnly.fieldErrors.cost;

const success: FormActionResult<"title"> = { ok: true };
const rejected: FormActionResult<"title"> = titleOnly;
// @ts-expect-error FormActionResult has no null/default state.
const noResult: FormActionResult<"title"> = null;
const wrongField: FormActionResult<"title"> = {
  ...titleOnly,
  fieldErrors: {
    // @ts-expect-error FormActionResult preserves the supplied writable fields.
    cost: { code: "invalid_input", message: "Wrong field" },
  },
};

test("public errors subpath has no runtime dependency surface", async () => {
  const module = await import("@autograph/generated-app-runtime/errors");
  expect(Object.keys(module)).toEqual([]);
  expect(titleOnly.fieldErrors.title?.code).toBe("constraint_violation");
  expect(success.ok).toBe(true);
  expect(rejected.ok).toBe(false);
  void noResult;
  void wrongField;
});
