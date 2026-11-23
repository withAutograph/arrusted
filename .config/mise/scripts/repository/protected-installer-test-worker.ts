// Private subprocess of the owned disposable protected-installer acceptance.
// This is not a product, deployment, or general installer entrypoint.
import { createInterface } from "node:readline";
import { Pool } from "pg";
import { createProtectedGeneratedInstaller } from "../../../../packages/generated-app-runtime/protected-installer";

type WorkerInput = Omit<
  Parameters<typeof createProtectedGeneratedInstaller>[0],
  "assertCurrent"
> & {
  action: "grant" | "revoke";
  pauseAfterFirstEffect: boolean;
};
const lines = createInterface({ input: process.stdin });
const messages = lines[Symbol.asyncIterator]();
const initial = await messages.next();
if (initial.done) throw new Error("Missing private fixture input");
const input = JSON.parse(initial.value) as WorkerInput;
const observer = new Pool({ connectionString: input.connections.appMigrator, max: 1 });
const authObserver = new Pool({ connectionString: input.connections.authMigrator, max: 1 });
let paused = false;
const report = (value: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  const installer = createProtectedGeneratedInstaller({
    ...input,
    assertCurrent: async () => {
      if (!input.pauseAfterFirstEffect || paused) return;
      const target = input.plan.organizations[0]!;
      const actor = target.actors[0]!;
      const observed = input.action === "grant"
        ? await observer.query(
            "select active,fence_generation from kernel_actor_membership where principal_name=$1 and app_id=$2 and customer_id=$3 and actor_id=$4 and role=$5",
            [input.plan.app.runtimeRole, input.plan.appId, target.organizationId, actor.actorId, actor.roles[0]],
          )
        : await authObserver.query(
            'select active,"fence_generation" as fence_generation from "app_actor_assignment" where "organizationId"=$1 and "actorId"=$2 and "appId"=$3 and role=$4',
            [target.organizationId, actor.actorId, input.plan.appId, actor.roles[0]],
          );
      if (
        observed.rows[0]?.active === (input.action === "grant") &&
        Number(observed.rows[0]?.fence_generation) === input.fenceGeneration
      ) {
        paused = true;
        report({ kind: "paused", pid: process.pid });
        const continuation = await messages.next();
        if (continuation.done || continuation.value !== "continue")
          throw new Error("fixture_interrupted");
      }
    },
  });
  if (input.action === "grant") await installer.grant();
  else await installer.revoke();
  report({ kind: "result", status: "applied", pid: process.pid });
} catch (error) {
  report({
    kind: "result",
    status: "rejected",
    assignmentFenceRejected:
      error instanceof Error && error.message === "protected_installer_assignment_fence_rejected",
    pid: process.pid,
  });
} finally {
  await observer.end();
  await authObserver.end();
  lines.close();
}
