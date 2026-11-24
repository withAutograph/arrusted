import { headers } from "next/headers";
import { errorMessage, redact } from "@autograph/auth/redact";
import { getIdentity } from "../../data/auth";
import { Invitations } from "./invitations";

export default async function Members() {
  const identity = getIdentity();
  const request = await headers();
  await identity.session(request);
  try {
    const [members, invitations] = await Promise.all([
      identity.members(request),
      identity.invitations(request),
    ]);
    return (
      <main className="page">
        <h1>Members</h1>
        <Invitations
          members={members}
          invitations={invitations.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() }))}
        />
      </main>
    );
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "owner_required")
      return (
        <main className="page">
          <h1>Members</h1>
          <p>Only an owner can manage members and invitations.</p>
        </main>
      );
    if (code === "no_owner")
      return (
        <main className="page">
          <h1>Members</h1>
          <p>
            No owner exists yet. Ask the builder to run{" "}
            <code>bun run owner:claim &lt;your-email&gt;</code> in their terminal.
          </p>
        </main>
      );
    console.error(redact(`Members page failed: ${errorMessage(error)}`));
    return (
      <main className="page">
        <h1>Members</h1>
        <p role="alert">Could not load members right now due to a server error. Try again.</p>
      </main>
    );
  }
}
