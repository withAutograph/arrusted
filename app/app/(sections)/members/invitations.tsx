"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { invite, promoteMember, removeMember, revoke } from "./actions";

export type MemberRow = { id: string; email: string; role: string };
export type InvitationRow = { id: string; email: string; status: string; expiresAt: string };

export function Invitations({
  members,
  invitations,
}: {
  members: MemberRow[];
  invitations: InvitationRow[];
}) {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ownerCount = members.filter((m) => m.role === "owner").length;

  async function run(action: () => Promise<{ error?: string }>) {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      if (result.error) setError(result.error);
      else router.refresh();
    } catch {
      setError("The request could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <p role="alert">{error}</p>}
      <section aria-label="Team members">
        <h2>Team members</h2>
        <ul>
          {members.map((member) => {
            const isLastOwner = member.role === "owner" && ownerCount <= 1;
            return (
              <li key={member.id}>
                {member.email} — {member.role}{" "}
                {member.role !== "owner" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => promoteMember(member.id))}
                  >
                    Make owner
                  </button>
                )}{" "}
                <button
                  type="button"
                  disabled={busy || isLastOwner}
                  title={isLastOwner ? "Cannot remove the last owner." : undefined}
                  onClick={() => void run(() => removeMember(member.id))}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="Invitations">
        <h2>Invitations</h2>
        <p>
          Invite links expire after seven days and work once, only for the invited email. Copy the
          link now; it cannot be retrieved later. Previously removed members can open a new invite
          link and sign in with their existing password to rejoin.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const email = String(new FormData(form).get("email"));
            setBusy(true);
            setError("");
            try {
              const result = await invite(email);
              if (result.error) setError(result.error);
              else {
                setLink(result.link ?? "");
                form.reset();
                router.refresh();
              }
            } catch {
              setError("Could not create invitation.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email <input type="email" name="email" required />
          </label>
          <button disabled={busy}>Invite</button>
        </form>
        {link && (
          <p>
            <input aria-label="Invitation link" readOnly value={link} />
            <button type="button" onClick={() => void navigator.clipboard.writeText(link)}>
              Copy link
            </button>
          </p>
        )}
        <ul>
          {invitations.map((i) => (
            <li key={i.id}>
              {i.email} — {i.status} — expires {i.expiresAt}{" "}
              {i.status === "pending" && (
                <button type="button" disabled={busy} onClick={() => void run(() => revoke(i.id))}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
