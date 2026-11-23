import { describe, expect, it } from "vite-plus/test";

import { enumFieldShapes } from "../../_shared/__tests__/helpers";

import { model_recruiting_blocks } from "../index";

describe("@domain-libs/recruiting", () => {
  it("exports recruiting domain blocks", () => {
    expect(blockNames(model_recruiting_blocks)).toEqual([
      "job",
      "job_opening",
      "candidate",
      "application",
      "interview",
      "offer",
    ]);
  });

  it("pins converted enum field shapes", () => {
    expect(enumFieldShapes(model_recruiting_blocks)).toEqual([
      ["job.status", ["open", "archived"]],
      ["job_opening.status", ["open", "closed", "draft", "archived", "pending"]],
      ["candidate.status", ["prospect", "active", "hired", "rejected", "withdrawn"]],
      ["candidate.source", ["inbound", "referral", "outbound", "agency", "job_board", "campus"]],
      ["application.status", ["active", "rejected", "hired", "withdrawn"]],
      [
        "application.current_stage",
        ["applied", "screen", "interview", "decision", "offer", "hired", "rejected"],
      ],
      ["application.source", ["inbound", "referral", "outbound", "agency", "job_board", "campus"]],
      [
        "application.rejection_reason",
        ["experience", "compensation", "location", "culture", "other"],
      ],
      ["interview.status", ["scheduled", "completed", "cancelled", "no_show"]],
      ["interview.stage", ["screen", "technical", "onsite", "final"]],
      ["interview.type", ["phone", "video", "onsite", "take_home"]],
      ["offer.status", ["draft", "sent", "accepted", "declined", "expired"]],
    ]);
  });
});

function blockNames(blocks: readonly { name: string }[]): string[] {
  return blocks.map((block) => block.name);
}
