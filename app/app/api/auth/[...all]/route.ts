import { withCanvasFrameCors } from "@autograph/auth/canvas-frame";
import { CANVAS_AUTH_ENDPOINTS } from "@autograph/auth/agent-grant-policy";
import { frameOrigins, getIdentity } from "../../../data/auth";
function handle(request: Request) {
  return withCanvasFrameCors(
    request,
    { origins: frameOrigins(), paths: CANVAS_AUTH_ENDPOINTS },
    (incoming) => getIdentity().auth.handler(incoming),
  );
}
export { handle as GET, handle as POST, handle as OPTIONS };
