export function errorMessage(error: unknown): string {
  const isError = (Error as { isError?: (value: unknown) => value is Error }).isError;
  if (isError?.(error)) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}
