import { canvas } from "../../../../data/canvas";
export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  return canvas.routes.events(request, (await context.params).sessionId);
}
