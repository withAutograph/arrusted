import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { Invitations } from "../../app/(sections)/members/invitations";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
const identityMock = {
  session: vi.fn(),
  members: vi.fn(),
  invitations: vi.fn(),
};
vi.mock("../../app/data/auth", () => ({
  getIdentity: () => identityMock,
}));
const inviteMock = vi.fn();
const revokeMock = vi.fn();
const promoteMock = vi.fn();
const removeMock = vi.fn();
vi.mock("../../app/(sections)/members/actions", () => ({
  invite: (...args: unknown[]) => inviteMock(...args),
  revoke: (...args: unknown[]) => revokeMock(...args),
  promoteMember: (...args: unknown[]) => promoteMock(...args),
  removeMember: (...args: unknown[]) => removeMock(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("members UI disables removing last owner, supports promote/remove/invite/revoke, and refreshes after actions", async () => {
  inviteMock.mockResolvedValue({ link: "https://app.example/auth/sign-in#invite=tok" });
  revokeMock.mockResolvedValue({});
  promoteMock.mockResolvedValue({});
  removeMock.mockResolvedValue({});

  render(
    <Invitations
      members={[
        { id: "u1", email: "owner@example.test", role: "owner" },
        { id: "u2", email: "member@example.test", role: "member" },
      ]}
      invitations={[
        {
          id: "inv1",
          email: "pending@example.test",
          status: "pending",
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      ]}
    />,
  );

  const removeButtons = screen.getAllByRole("button", { name: "Remove" });
  expect((removeButtons[0] as HTMLButtonElement).disabled).toBe(true);
  expect((removeButtons[1] as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
  await waitFor(() => expect(promoteMock).toHaveBeenCalledWith("u2"));
  expect(refresh).toHaveBeenCalledTimes(1);

  fireEvent.click(removeButtons[1]!);
  await waitFor(() => expect(removeMock).toHaveBeenCalledWith("u2"));
  expect(refresh).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(revokeMock).toHaveBeenCalledWith("inv1"));
  expect(refresh).toHaveBeenCalledTimes(3);

  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Invite" }));
  await waitFor(() => expect(inviteMock).toHaveBeenCalledWith("new@example.test"));
  expect(refresh).toHaveBeenCalledTimes(4);
  expect((screen.getByLabelText("Invitation link") as HTMLInputElement).value).toContain(
    "#invite=",
  );
});

test("members UI surfaces server action errors without refreshing", async () => {
  removeMock.mockResolvedValue({ error: "Cannot remove the last owner." });
  render(
    <Invitations
      members={[
        { id: "u1", email: "owner1@example.test", role: "owner" },
        { id: "u2", email: "owner2@example.test", role: "owner" },
      ]}
      invitations={[]}
    />,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Cannot remove the last owner."),
  );
  expect(refresh).not.toHaveBeenCalled();
});

test("Members page distinguishes owner_required, no_owner (mentions owner:claim), and server errors", async () => {
  const { default: Members } = await import("../../app/(sections)/members/page");
  identityMock.session.mockResolvedValue({ actorId: "u1", customerId: "starter" });

  identityMock.members.mockRejectedValueOnce(
    Object.assign(new Error("Only an owner can manage members."), { code: "owner_required" }),
  );
  identityMock.invitations.mockResolvedValueOnce([]);
  render(await Members());
  expect(screen.getByText(/Only an owner can manage members/)).toBeTruthy();
  cleanup();

  identityMock.members.mockRejectedValueOnce(
    Object.assign(new Error("No owner exists."), { code: "no_owner" }),
  );
  identityMock.invitations.mockResolvedValueOnce([]);
  render(await Members());
  expect(screen.getByText(/owner:claim/)).toBeTruthy();
  cleanup();

  const prevError = console.error;
  console.error = () => {};
  try {
    identityMock.members.mockRejectedValueOnce(new Error("connection refused"));
    identityMock.invitations.mockResolvedValueOnce([]);
    render(await Members());
    expect(screen.getByRole("alert").textContent).toContain("server error");
    expect(screen.queryByText(/Only an owner/)).toBeNull();
  } finally {
    console.error = prevError;
  }
});
