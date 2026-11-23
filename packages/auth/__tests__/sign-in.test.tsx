import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  signUpOptions: {
    current: undefined as
      | undefined
      | { onSuccess: (data: unknown, variables: { email: string }) => void },
  },
  navigate: vi.fn(),
  useAuth: vi.fn(),
  session: null as unknown,
}));

vi.mock("@better-auth-ui/react", () => ({
  AuthPrompts: () => null,
  useAuth: mocks.useAuth,
  useFetchOptions: () => ({ fetchOptions: {}, resetFetchOptions: vi.fn() }),
  useSignInEmail: () => ({ isPending: false, mutate: mocks.signInEmail }),
  useSignUpEmail: (_client: unknown, options: NonNullable<typeof mocks.signUpOptions.current>) => {
    mocks.signUpOptions.current = options;
    return { isPending: false, mutate: mocks.signUpEmail };
  },
  useSession: () => ({ data: mocks.session, isPending: false }),
}));

vi.mock("@tanstack/react-query", () => ({
  useIsMutating: () => 0,
}));

vi.mock("#lib/auth/use-sign-in-continuation", () => ({
  useSignInContinuation: () => vi.fn(),
}));

vi.mock("../components/auth/last-login-method/last-used-badge", () => ({
  LastUsedBadge: () => null,
}));

vi.mock("../components/auth/additional-field", () => ({
  AdditionalField: () => null,
}));

vi.mock("../components/auth/provider-buttons", () => ({
  ProviderButtons: () => null,
}));

import { SignIn } from "../components/auth/sign-in";
import { SignUp } from "../components/auth/sign-up";

const localization = {
  auth: {
    alreadyHaveAnAccount: "Already have an account?",
    email: "Email",
    emailPlaceholder: "name@example.com",
    fieldRequired: "Required",
    forgotPasswordLink: "Forgot password?",
    hidePassword: "Hide password",
    invalidEmail: "Invalid email",
    needToCreateAnAccount: "Need to create an account?",
    or: "OR",
    password: "Password",
    passwordPlaceholder: "Password",
    rememberMe: "Remember me",
    showPassword: "Show password",
    signIn: "Sign In",
    signUp: "Sign Up",
    tooLong: "Must be at most {{max}} characters",
    tooShort: "Must be at least {{min}} characters",
  },
};

function configureAuth({
  signUpPath,
  redirectTo,
  requireEmailVerification = false,
}: {
  signUpPath: string;
  redirectTo?: string;
  requireEmailVerification?: boolean;
}) {
  mocks.useAuth.mockReturnValue({
    authClient: {},
    basePaths: { auth: "/auth" },
    baseURL: window.location.origin,
    redirectTo,
    emailAndPassword: {
      enabled: true,
      name: false,
      requireEmailVerification,
      forgotPassword: false,
      maxPasswordLength: 128,
      minPasswordLength: 8,
      rememberMe: false,
    },
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
      <a href={href}>{children}</a>
    ),
    localization,
    navigate: mocks.navigate,
    plugins: [],
    socialProviders: [{ provider: "google" }],
    viewPaths: {
      auth: {
        forgotPassword: "forgot-password",
        signIn: "sign-in",
        signUp: signUpPath,
        verifyEmail: "verify-email",
      },
    },
  });
}

describe("SignIn", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/auth/sign-in");
    mocks.signInEmail.mockReset();
    mocks.signUpEmail.mockReset();
    mocks.navigate.mockReset();
    mocks.signUpOptions.current = undefined;
    mocks.useAuth.mockReset();
    mocks.session = null;
  });

  it("keeps email and password sign-in available when sign-up is disabled", () => {
    configureAuth({ signUpPath: "sign-in" });

    render(<SignIn />);

    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign Up" })).not.toBeInTheDocument();
  });

  it("shows the sign-up prompt only when a distinct sign-up route is available", () => {
    configureAuth({ signUpPath: "sign-up" });

    render(<SignIn />);

    expect(screen.getByRole("link", { name: "Sign Up" })).toHaveAttribute("href", "/auth/sign-up");
  });

  it("shows a safe Google callback error without echoing the provider description", async () => {
    window.history.replaceState(
      {},
      "",
      "/auth/sign-in?redirectTo=%2F&error=signup_disabled&error_description=private-provider-detail",
    );
    configureAuth({ signUpPath: "sign-in" });

    render(<SignIn />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Google account is not authorized to access Autograph.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-provider-detail");
    expect(window.location.href).toBe(`${window.location.origin}/auth/sign-in?redirectTo=%2F`);
  });
});

describe("auth return navigation", () => {
  const returnPath =
    "/api/auth/platform/operator-link?connection=synthetic&returnTo=%2Fworkspace%3Ftab%3Dapps";

  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.signUpEmail.mockReset();
    mocks.signUpOptions.current = undefined;
    mocks.session = null;
  });

  it("automatically continues an authenticated signup-page visit into the approved app", async () => {
    mocks.session = { user: { id: "existing-user" }, session: { id: "existing-session" } };
    configureAuth({ signUpPath: "sign-up", redirectTo: "/workspace" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ready",
          appUrl: `${window.location.origin}/workspace`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    render(<SignUp />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/platform/signup-continue",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("Expected a JSON signup continuation body");
    expect(JSON.parse(body)).toEqual({
      appUrl: `${window.location.origin}/workspace`,
    });
    fetchMock.mockRestore();
  });

  it.each(["relative", "same-origin absolute"])(
    "preserves a %s connection return through sign-up and back to sign-in",
    (kind) => {
      const redirectTo =
        kind === "relative" ? returnPath : `${window.location.origin}${returnPath}`;
      configureAuth({ signUpPath: "sign-up", redirectTo });
      const signIn = render(<SignIn />);
      const signUpURL = new URL(
        screen.getByRole("link", { name: "Sign Up" }).getAttribute("href")!,
        window.location.origin,
      );
      expect(signUpURL.pathname).toBe("/auth/sign-up");
      expect(signUpURL.searchParams.get("redirectTo")).toBe(returnPath);
      signIn.unmount();

      configureAuth({
        signUpPath: "sign-up",
        redirectTo: signUpURL.searchParams.get("redirectTo")!,
      });
      render(<SignUp />);
      const signInURL = new URL(
        screen.getByRole("link", { name: "Sign In" }).getAttribute("href")!,
        window.location.origin,
      );
      expect(signInURL.pathname).toBe("/auth/sign-in");
      expect(signInURL.searchParams.get("redirectTo")).toBe(returnPath);

      fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
        target: { value: "synthetic@example.com" },
      });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "synthetic-password" },
      });
      fireEvent.submit(screen.getByRole("button", { name: "Sign Up" }).closest("form")!);
      expect(mocks.signUpEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "synthetic@example.com" }),
      );
      mocks.signUpOptions.current!.onSuccess({}, { email: "synthetic@example.com" });
      expect(mocks.navigate).toHaveBeenCalledWith({ to: returnPath });
    },
  );

  it("preserves the return through required email verification", () => {
    configureAuth({
      signUpPath: "sign-up",
      redirectTo: returnPath,
      requireEmailVerification: true,
    });
    render(<SignUp />);
    mocks.signUpOptions.current!.onSuccess({}, { email: "synthetic@example.com" });
    const destination = new URL(mocks.navigate.mock.calls[0]![0].to, window.location.origin);
    expect(destination.pathname).toBe("/auth/verify-email");
    expect(destination.searchParams.get("redirectTo")).toBe(returnPath);
  });

  it.each([
    "https://external.invalid/collect",
    "//external.invalid/collect",
    "/\\external.invalid/collect",
    "/path\nexternal",
  ])("falls back safely for %j", (redirectTo) => {
    configureAuth({ signUpPath: "sign-up", redirectTo });
    const signIn = render(<SignIn />);
    expect(screen.getByRole("link", { name: "Sign Up" })).toHaveAttribute("href", "/auth/sign-up");
    signIn.unmount();

    render(<SignUp />);
    const destination = new URL(
      screen.getByRole("link", { name: "Sign In" }).getAttribute("href")!,
      window.location.origin,
    );
    expect(destination.searchParams.get("redirectTo")).toBe("/");
    mocks.signUpOptions.current!.onSuccess({}, { email: "synthetic@example.com" });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  });
});
