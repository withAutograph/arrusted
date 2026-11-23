import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAuth, useSession } from "@better-auth-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { AuthUiProvider, type AuthUiProviderProps } from "../ui-provider";
import { Auth } from "../components/auth/auth";
import { SignUp } from "../components/auth/sign-up";
import { createAuthQueryClient } from "../query-client";

const { navigate, request } = vi.hoisted(() => {
  const request = vi.fn<typeof fetch>();
  // Better Auth captures its fetch implementation when the client is constructed.
  vi.stubGlobal("fetch", request);
  return { navigate: vi.fn(), request };
});

beforeEach(() => {
  navigate.mockReset();
  request.mockReset().mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response(
      JSON.stringify(
        url.includes("request-password-reset")
          ? { status: true, message: "If this email exists, check your inbox." }
          : null,
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", request);
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});

function view(
  path: string,
  allowPasswordRecovery = true,
  emailAndPassword?: AuthUiProviderProps["emailAndPassword"],
) {
  return render(
    <AuthUiProvider
      navigate={navigate}
      baseURL="http://localhost:3000"
      basePaths={{ auth: "/auth" }}
      queryClient={createAuthQueryClient()}
      allowPasswordRecovery={allowPasswordRecovery}
      emailAndPassword={emailAndPassword}
    >
      <Auth path={path} />
    </AuthUiProvider>,
  );
}

function requestedResetCallback() {
  const resetRequest = request.mock.calls.find(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.includes("request-password-reset");
  });
  const body = resetRequest?.[1]?.body;
  if (typeof body !== "string") throw new Error("Expected the reset form's JSON request body.");
  const parsed = JSON.parse(body) as { redirectTo: string };
  return new URL(parsed.redirectTo);
}

it("does not enroll a policy-backed Production app merely by opening signup with a session cookie", async () => {
  let resolveSession!: (response: Response) => void;
  const sessionResponse = new Promise<Response>((resolve) => {
    resolveSession = resolve;
  });
  request.mockImplementation(async () => sessionResponse);
  function SessionState() {
    const { authClient } = useAuth();
    const { data, isPending } = useSession(authClient);
    return (
      <output>
        {isPending
          ? "session pending"
          : data?.user.id === "existing"
            ? "session resolved: existing"
            : "no session"}
      </output>
    );
  }
  const authenticated = Response.json({
    user: {
      id: "existing",
      email: "existing@example.test",
      name: "Existing",
      emailVerified: true,
    },
    session: { id: "session", userId: "existing" },
  });
  render(
    <AuthUiProvider
      navigate={navigate}
      baseURL="http://localhost:3000"
      redirectTo="/apps/fixture"
      queryClient={createAuthQueryClient()}
      emailAndPassword={{ requireEmailVerification: true }}
    >
      <SignUp />
      <SessionState />
    </AuthUiProvider>,
  );
  await screen.findByRole("button", { name: /sign up/i });
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(screen.getByText("session pending")).toBeInTheDocument();
  await act(async () => resolveSession(authenticated));
  await screen.findByText("session resolved: existing");
  await act(async () => {});
  expect(
    request.mock.calls.some(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("signup-continue");
    }),
  ).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it("offers recovery on sign-in only when its server capability is enabled", async () => {
  const disabled = view("sign-in", false);
  await screen.findByRole("button", { name: "Sign In" });
  expect(screen.queryByRole("link", { name: /forgot password/i })).not.toBeInTheDocument();
  disabled.unmount();
  view("sign-in");
  expect(await screen.findByRole("link", { name: /forgot password/i })).toHaveAttribute(
    "href",
    "/auth/forgot-password",
  );
});

it("requests the normal recovery API and navigates to the non-enumerating confirmation", async () => {
  view("forgot-password");
  fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
    target: { value: "owner@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/auth/reset-link-sent" }));
  expect(
    request.mock.calls.some(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("request-password-reset");
    }),
  ).toBe(true);
});

it("returns to the same app after recovery, retaining its query through confirmation and reset", async () => {
  const appPath = "/apps/recovery-fixture/notebook?view=mine&tag=follow+up";
  const signInPath = `/auth/sign-in?${new URLSearchParams({ redirectTo: appPath })}`;
  window.history.replaceState({}, "", signInPath);
  const signIn = view("sign-in");
  const forgotPath = (await screen.findByRole("link", { name: /forgot password/i })).getAttribute(
    "href",
  )!;
  expect(new URL(forgotPath, window.location.origin).searchParams.get("redirectTo")).toBe(appPath);
  signIn.unmount();

  window.history.replaceState({}, "", forgotPath);
  const forgot = view("forgot-password");
  fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
    target: { value: "owner@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  const confirmationPath = navigate.mock.calls.at(-1)![0].to;
  expect(new URL(confirmationPath, window.location.origin).searchParams.get("redirectTo")).toBe(
    appPath,
  );
  const resetUrl = requestedResetCallback();
  expect(resetUrl.origin).toBe("http://localhost:3000");
  expect(resetUrl.pathname).toBe("/auth/reset-password");
  expect(resetUrl.searchParams.get("redirectTo")).toBe(appPath);
  forgot.unmount();

  window.history.replaceState({}, "", confirmationPath);
  const confirmation = view("reset-link-sent");
  expect(await screen.findByRole("link", { name: "Sign In" })).toHaveAttribute("href", signInPath);
  confirmation.unmount();

  // The provider appends its one-use token to the callback supplied by the real form.
  resetUrl.searchParams.set("token", "controlled-reset-token");
  window.history.replaceState({}, "", `${resetUrl.pathname}${resetUrl.search}`);
  navigate.mockClear();
  const reset = view("reset-password", true, { confirmPassword: false });
  fireEvent.change(await screen.findByLabelText("Password"), {
    target: { value: "controlled-new-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: signInPath }));
  reset.unmount();

  window.history.replaceState({}, "", signInPath);
  navigate.mockClear();
  view("sign-in");
  fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
    target: { value: "owner@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "controlled-new-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: appPath }));
});

it.each(["https://unrelated.example/app", "//unrelated.example/app"])(
  "keeps recovery on the Auth origin when the requested app return is %s",
  async (redirectTo) => {
    window.history.replaceState(
      {},
      "",
      `/auth/forgot-password?${new URLSearchParams({ redirectTo })}`,
    );
    view("forgot-password");
    fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
      target: { value: "owner@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const resetUrl = requestedResetCallback();
    expect(resetUrl.origin).toBe("http://localhost:3000");
    expect(resetUrl.pathname).toBe("/auth/reset-password");
    expect(resetUrl.searchParams.get("redirectTo") ?? "/").toBe("/");
    const confirmation = new URL(navigate.mock.calls.at(-1)![0].to, window.location.origin);
    expect(confirmation.origin).toBe(window.location.origin);
    expect(confirmation.searchParams.get("redirectTo") ?? "/").toBe("/");
  },
);

it("preserves custom sign-in settings while gating recovery by the server capability", async () => {
  const custom = view("sign-in", true, { minPasswordLength: 12 });
  expect(await screen.findByRole("link", { name: /forgot password/i })).toBeInTheDocument();
  custom.unmount();
  const hidden = view("sign-in", true, { forgotPassword: false });
  await screen.findByRole("button", { name: "Sign In" });
  expect(screen.queryByRole("link", { name: /forgot password/i })).not.toBeInTheDocument();
  hidden.unmount();
  view("sign-in", false, { forgotPassword: true });
  await screen.findByRole("button", { name: "Sign In" });
  expect(screen.queryByRole("link", { name: /forgot password/i })).not.toBeInTheDocument();
});

it("does not claim an account exists or an email was delivered", async () => {
  sessionStorage.setItem("better-auth-ui.reset-link-sent", "owner@example.test");
  view("reset-link-sent");
  expect(await screen.findByText(/If an account exists for/)).toBeInTheDocument();
});
