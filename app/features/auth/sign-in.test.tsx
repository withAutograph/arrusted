import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { SignIn } from "../../app/auth/sign-in/sign-in";
const signUpMock = vi.fn();
const signInMock = vi.fn();
vi.mock("@autograph/auth/client", () => ({
  authClient: {
    signUp: { email: (...args: unknown[]) => signUpMock(...args) },
    signIn: { email: (...args: unknown[]) => signInMock(...args) },
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});
test("closed signin does not advertise account creation", () => {
  render(
    <StrictMode>
      <SignIn redirectTo="/" oauth={false} openSignUp={false} />
    </StrictMode>,
  );
  expect(screen.queryByText("Create an account")).toBeNull();
});
test("open signup advertises account creation", () => {
  render(<SignIn redirectTo="/" oauth={false} openSignUp />);
  expect(screen.getByText("Create an account")).toBeTruthy();
});
for (const proof of ["setup", "invite"])
  test(`${proof} fragment permits signup and is immediately cleared`, async () => {
    window.history.replaceState(null, "", `/auth/sign-in#${proof}=private-proof`);
    render(
      <StrictMode>
        <SignIn redirectTo="/" oauth={false} openSignUp={false} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText("Create your account")).toBeTruthy());
    expect(window.location.hash).toBe("");
    expect(document.body.textContent).not.toContain("private-proof");
  });

test("invite fragment lets an existing memberless user switch to Sign in and accept the invitation with their existing password", async () => {
  window.history.replaceState(null, "", "/auth/sign-in#invite=rejoin-secret-token");
  signInMock.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json(
        { message: "This invitation is invalid, expired, revoked, used, or for another email." },
        { status: 403 },
      ),
    );

  render(
    <StrictMode>
      <SignIn redirectTo="/" oauth={false} openSignUp={false} />
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByText("Create your account")).toBeTruthy());
  expect(window.location.hash).toBe("");

  fireEvent.click(screen.getByRole("button", { name: "Already have an account? Sign in" }));
  expect(screen.getByText(/existing password/i)).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "member@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "existing-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  expect(signInMock).toHaveBeenCalledTimes(1);
  expect(signUpMock).not.toHaveBeenCalled();
  const [url, init] = fetchSpy.mock.calls[0]!;
  expect(url).toBe("/api/auth/accept-member-invitation");
  expect(init?.method).toBe("POST");
  expect((init?.headers as Record<string, string>)["x-invitation"]).toBe("rejoin-secret-token");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("invitation is invalid"),
  );
  expect(document.body.textContent).not.toContain("rejoin-secret-token");
});
