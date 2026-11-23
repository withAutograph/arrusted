import { canvas } from "../../../data/canvas";
import { frameOrigins } from "../../../data/auth";
import { withCanvasFrameCors } from "@autograph/auth/canvas-frame";
function handle(request: Request) {
  return withCanvasFrameCors(
    request,
    { origins: frameOrigins(), paths: ["/starter/api/canvas"] },
    canvas.routes.canvas,
  );
}
export { handle as POST, handle as OPTIONS };
