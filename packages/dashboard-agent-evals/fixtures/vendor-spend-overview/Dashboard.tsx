import submission from "./submission.json";
import { ChartComposition } from "../../../../packages/design-systems/core/compositions";
import type { DashboardEvalSubmission } from "../../types";

// This fixture is intentionally small. A real generated dashboard would receive
// these normalized arrays from an app-owned adapter over generated-client DTOs.
export function DashboardFixture() {
  return (
    <div>
      {(submission as DashboardEvalSubmission).charts.map((chart) => (
        <ChartComposition key={chart.id} spec={{ type: "chart", config: chart.config as never }} />
      ))}
    </div>
  );
}
