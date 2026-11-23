import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  signInSocial: vi.fn(),
}));

vi.mock("@better-auth-ui/react", () => ({
  providerIcons: {},
  useAuth: () => ({
    authClient: {},
    baseURL: "https://apps.autograph.so",
    localization: { auth: { continueWith: "Continue with {{provider}}" } },
    redirectTo: "/",
  }),
  useSignInSocial: () => ({ isPending: false, mutate: mocks.signInSocial }),
}));

vi.mock("@tanstack/react-query", () => ({
  useIsMutating: () => 0,
}));

vi.mock("../components/auth/last-login-method/last-used-badge", () => ({
  LastUsedBadge: () => null,
}));

import { ProviderButton } from "../components/auth/provider-button";

describe("ProviderButton", () => {
  beforeEach(() => {
    mocks.signInSocial.mockReset();
    window.history.replaceState(
      {},
      "",
      "/auth/sign-in?redirectTo=%2F&error=signup_disabled&error_description=private",
    );
  });

  it("returns OAuth failures to the current clean sign-in URL", () => {
    render(<ProviderButton provider="google" />);

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "https://apps.autograph.so/",
      errorCallbackURL: `${window.location.origin}/auth/sign-in?redirectTo=%2F`,
    });
  });
});
