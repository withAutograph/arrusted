import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { SignIn } from "../../app/auth/sign-in/sign-in";
import { SetPassword } from "../../app/auth/set-password/set-password";

const signInMock = vi.fn();
const resetPasswordMock = vi.fn();
vi.mock("@autograph/auth/client", () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => signInMock(...args) },
    resetPassword: (...args: unknown[]) => resetPasswordMock(...args),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

test("sign-in renders email and password only, without sign-up UI, and preserves OAuth flow", async () => {
  signInMock.mockResolvedValueOnce({ data: {}, error: null });
  render(
    <StrictMode>
      <SignIn redirectTo="/overview" oauth={true} />
    </StrictMode>,
  );
  expect(screen.queryByText(/create an account|sign up/i)).toBeNull();
  expect(screen.queryByLabelText("Name")).toBeNull();

  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "valid-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await waitFor(() =>
    expect(signInMock).toHaveBeenCalledWith({
      email: "alice@example.test",
      password: "valid-password-123",
      callbackURL: "/overview",
    }),
  );
});

test("set-password reads #token, clears hash, validates confirmation, resets password, and links to sign-in", async () => {
  window.history.replaceState(null, "", "/auth/set-password#token=secret-reset-token");
  resetPasswordMock.mockResolvedValueOnce({ data: { status: true }, error: null });

  render(
    <StrictMode>
      <SetPassword />
    </StrictMode>,
  );
  await waitFor(() => expect(window.location.hash).toBe(""));
  expect(document.body.textContent).not.toContain("secret-reset-token");

  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "new-password-123" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "different-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
  expect(screen.getByRole("alert").textContent).toContain("do not match");
  expect(resetPasswordMock).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "new-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));

  await waitFor(() =>
    expect(resetPasswordMock).toHaveBeenCalledWith({
      newPassword: "new-password-123",
      token: "secret-reset-token",
    }),
  );
  await waitFor(() => expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy());
});

test("set-password shows a plain message for missing or invalid/expired tokens", async () => {
  window.history.replaceState(null, "", "/auth/set-password");
  render(<SetPassword />);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(/invalid or has expired/i),
  );
  cleanup();

  window.history.replaceState(null, "", "/auth/set-password#token=expired-token");
  resetPasswordMock.mockResolvedValueOnce({
    data: null,
    error: { code: "INVALID_TOKEN", message: "Invalid token" },
  });
  render(<SetPassword />);
  await waitFor(() => expect(window.location.hash).toBe(""));
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "new-password-123" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "new-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(/invalid or has expired/i),
  );
});
