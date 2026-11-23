/** Browser-safe form error contract. This module deliberately has no runtime dependencies. */
export type FormErrorCode =
  | "invalid_input"
  | "conflict"
  | "constraint_violation"
  | "not_found"
  | "forbidden";
export type FormError<Field extends string = string> = {
  ok: false;
  code: FormErrorCode;
  message: string;
  fieldErrors: Partial<
    Record<
      Field,
      {
        code: "invalid_input" | "conflict" | "constraint_violation";
        message: string;
      }
    >
  >;
};

/** Browser-safe result returned by app-owned form actions. */
export type FormActionResult<Field extends string> = { ok: true } | FormError<Field>;
