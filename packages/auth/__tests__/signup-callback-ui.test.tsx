import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { request, navigate } = vi.hoisted(() => {
  const request = vi.fn<typeof fetch>(async () => Response.json(null));
  vi.stubGlobal("fetch", request);
  return { request, navigate: vi.fn() };
});

import type { AuthUiLinkComponent } from "../ui-provider";

const Link: AuthUiLinkComponent = ({ children, href, to, ...props }) => (
  <a href={to ?? href} {...props}>
    {children}
  </a>
);

import { authClient } from "../client";
import { AuthProvider } from "../components/auth/auth-provider";
import { SignUp } from "../components/auth/sign-up";
import { createAuthQueryClient } from "../query-client";

beforeEach(() => {
  request.mockClear();
  navigate.mockClear();
  window.history.replaceState({}, "", "/auth/sign-up");
});
afterEach(() => {
  window.history.replaceState({}, "", "/");
});

async function submit() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "signup@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "controlled-signup-password-123" },
  });
  fireEvent.submit(screen.getByRole("button", { name: "Sign Up" }).closest("form")!);
  let body: Record<string, unknown> | undefined;
  await waitFor(() => {
    const signup = request.mock.calls.find(([input]) =>
      (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes(
        "/sign-up/email",
      ),
    );
    expect(typeof signup?.[1]?.body).toBe("string");
    body = JSON.parse(signup![1]!.body as string) as Record<string, unknown>;
  });
  return body;
}

it("does not allow additional fields to replace the selected app callback", async () => {
  render(
    <AuthProvider
      Link={Link}
      authClient={authClient}
      navigate={navigate}
      queryClient={createAuthQueryClient()}
      redirectTo="/recovery-fixture/notes"
      signUpRedirectTo="/recovery-fixture"
      emailAndPassword={{ name: false, confirmPassword: false, requireEmailVerification: true }}
      additionalFields={[
        {
          name: "callbackURL",
          type: "string",
          label: "Custom callback",
          signUp: true,
          defaultValue: "https://unrelated.example/collect",
        },
      ]}
    >
      <SignUp />
    </AuthProvider>,
  );
  expect(screen.getByLabelText(/Custom callback/)).toHaveValue("https://unrelated.example/collect");
  const body = await submit();
  expect(body?.callbackURL).toBe(new URL("/recovery-fixture", window.location.origin).href);
});

it("keeps ordinary local signup working without a managed app policy", async () => {
  const destination = "/workspace?view=mine";
  render(
    <AuthProvider
      Link={Link}
      authClient={authClient}
      navigate={navigate}
      queryClient={createAuthQueryClient()}
      redirectTo={destination}
      emailAndPassword={{ name: false, confirmPassword: false }}
    >
      <SignUp />
    </AuthProvider>,
  );
  const body = await submit();
  expect(body?.callbackURL).toBe(new URL(destination, window.location.origin).href);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: destination }));
});
