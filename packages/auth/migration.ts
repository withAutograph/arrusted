// Protected CLI entrypoint. Runtime imports auth.ts and never selects this purpose.
import { createAuth, readAuthApplicationName } from "./server";

if (process.env.AUTH_DATABASE_RESOURCE !== undefined)
  throw new Error("Enrolled Auth migrations require the reviewed schema plan");

export const auth = createAuth({
  appName: readAuthApplicationName(),
  databasePurpose: "migrator",
});
export default auth;
