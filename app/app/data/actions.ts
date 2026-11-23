"use server";
import { canvas } from "./canvas";
export async function session(input: unknown) {
  return canvas.mutations.session(input);
}
export async function drafts(path: unknown, body: unknown) {
  return canvas.mutations.drafts(path, body);
}
export async function threads(operation: unknown, input: unknown) {
  return canvas.mutations.threads(operation, input);
}
export async function createSession(input: unknown) {
  return canvas.mutations.createSession(input);
}
