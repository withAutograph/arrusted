import { dashboardEvalCorpus } from "./corpus";
import { evaluateDashboardSubmissionFile } from "./index";

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const evalCase of dashboardEvalCorpus) {
    console.log(`${evalCase.id}\t${evalCase.title}`);
  }
  process.exit(0);
}

const caseId = valueAfter(args, "--case");
const submissionPath = valueAfter(args, "--submission");
if (!caseId || !submissionPath) {
  console.error(
    "Usage: mise run eval:dashboard-agent -- --case <case-id> --submission <submission.json> [--json]",
  );
  process.exit(2);
}

let report;
try {
  report = await evaluateDashboardSubmissionFile({ caseId, submissionPath });
} catch (error) {
  console.error(
    `Invalid dashboard submission: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}
if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `${report.passed ? "PASS" : "FAIL"} ${report.caseId}: ${report.score}/${report.maximumScore}`,
  );
  for (const check of report.checks) {
    console.log(
      `${check.passed ? "✓" : "✗"} ${check.label} (${check.earned}/${check.points})${check.detail ? ` — ${check.detail}` : ""}`,
    );
  }
}
process.exit(report.passed ? 0 : 1);

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
