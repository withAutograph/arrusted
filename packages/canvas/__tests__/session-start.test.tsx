// Starting a canvas session: an unconfirmed create retried with the same
// title (as the host stores it, trimmed) replays it, never a second session.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { NewSessionForm, type StartSessionInput, type StartSessionResult } from "../session-start";

describe("NewSessionForm", () => {
  it("retries an unconfirmed create with the same ids when only the title's surrounding spaces change", async () => {
    const create = vi.fn<(input: StartSessionInput) => Promise<StartSessionResult>>();
    create.mockResolvedValueOnce({
      ok: false,
      error: { code: "outcome_unknown", message: "We couldn't confirm that." },
    });
    create.mockResolvedValueOnce({ ok: true, value: { sessionId: "s-1" } });
    const onCreated = vi.fn();
    render(<NewSessionForm create={create} onCreated={onCreated} />);
    const user = userEvent.setup();
    const title = screen.getByLabelText(/Title/u);
    await user.type(title, " Plan ");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await user.clear(title);
    await user.type(title, "Plan");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("s-1"));
    const [first, second] = create.mock.calls.map(([input]) => input);
    expect(second!.session_id).toBe(first!.session_id);
    expect(second!.request_id).toBe(first!.request_id);
    expect(second!.as_of).toBe(first!.as_of);
  });
});
