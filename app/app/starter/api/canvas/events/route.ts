import { canvas } from "../../../../data/canvas";
import { frameOrigins } from "../../../../data/auth";
import { withCanvasFrameCors } from "@autograph/auth/canvas-frame";
function handle(request: Request) {
  return withCanvasFrameCors(
    request,
    { origins: frameOrigins(), paths: ["/starter/api/canvas/events"] },
    canvas.routes.canvasEvents,
  );
}
export { handle as GET, handle as OPTIONS };
