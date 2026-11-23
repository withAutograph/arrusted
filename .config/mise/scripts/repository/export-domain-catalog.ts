import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  lookup_core_blocks,
  lookup_geography_blocks,
  lookup_other_blocks,
} from "../../../../packages/domain-libs/_shared";
import {
  model_accounting_blocks,
  model_exchange_rate_blocks,
} from "../../../../packages/domain-libs/accounting";
import {
  buildCatalogArtifact,
  type CatalogSource,
} from "../../../../packages/engines/schema-catalog";
import {
  lookup_compensation_blocks,
  lookup_equity_blocks,
  model_compensation_blocks,
} from "../../../../packages/domain-libs/compensation";
import { model_contractor_blocks } from "../../../../packages/domain-libs/contractor";
import {
  lookup_capacity_blocks,
  lookup_employee_profile_blocks,
  lookup_employee_workforce_blocks,
  lookup_performance_blocks,
  model_employee_blocks,
} from "../../../../packages/domain-libs/employee";
import { model_org_assignment_blocks } from "../../../../packages/domain-libs/org-assignment";
import { model_position_blocks } from "../../../../packages/domain-libs/position";
import { model_recruiting_blocks } from "../../../../packages/domain-libs/recruiting";
import { model_requisition_blocks } from "../../../../packages/domain-libs/requisition";
import {
  lookup_revenue_blocks,
  model_revenue_blocks,
} from "../../../../packages/domain-libs/revenue";
import {
  model_vendor_blocks,
  model_vendor_spend_blocks,
} from "../../../../packages/domain-libs/vendor";

const EXPECTED_MODEL_INVENTORY = [
  ["chart_account", "@domain-libs/accounting"],
  ["exchange_rate", "@domain-libs/accounting"],
  ["department", "@domain-libs/_shared"],
  ["location", "@domain-libs/_shared"],
  ["pnl_category", "@domain-libs/_shared"],
  ["geography", "@domain-libs/_shared"],
  ["business_unit", "@domain-libs/_shared"],
  ["job_family", "@domain-libs/compensation"],
  ["level", "@domain-libs/compensation"],
  ["comp_zone", "@domain-libs/compensation"],
  ["bonus", "@domain-libs/compensation"],
  ["equity_grant", "@domain-libs/compensation"],
  ["benefits_policy", "@domain-libs/compensation"],
  ["employer_tax_policy", "@domain-libs/compensation"],
  ["contractor", "@domain-libs/contractor"],
  ["cx_capacity_template", "@domain-libs/employee"],
  ["quota_capacity_template", "@domain-libs/employee"],
  ["initiative", "@domain-libs/employee"],
  ["segment", "@domain-libs/employee"],
  ["entity", "@domain-libs/employee"],
  ["employee", "@domain-libs/employee"],
  ["org_assignment", "@domain-libs/org-assignment"],
  ["position", "@domain-libs/position"],
  ["job", "@domain-libs/recruiting"],
  ["job_opening", "@domain-libs/recruiting"],
  ["candidate", "@domain-libs/recruiting"],
  ["application", "@domain-libs/recruiting"],
  ["interview", "@domain-libs/recruiting"],
  ["offer", "@domain-libs/recruiting"],
  ["requisition", "@domain-libs/requisition"],
  ["product", "@domain-libs/revenue"],
  ["price", "@domain-libs/revenue"],
  ["customer", "@domain-libs/revenue"],
  ["subscription", "@domain-libs/revenue"],
  ["subscription_item", "@domain-libs/revenue"],
  ["subscription_schedule", "@domain-libs/revenue"],
  ["vendor", "@domain-libs/vendor"],
  ["vendor_spend_transaction", "@domain-libs/vendor"],
] as const;
const outputPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/domain-libs/catalog.json",
);
const check = process.argv.includes("--check");

const sources: CatalogSource[] = [
  {
    package: "@domain-libs/accounting",
    blocks: [...model_accounting_blocks, ...model_exchange_rate_blocks],
  },
  {
    package: "@domain-libs/_shared",
    blocks: [...lookup_core_blocks, ...lookup_geography_blocks, ...lookup_other_blocks],
  },
  {
    package: "@domain-libs/compensation",
    blocks: [...lookup_compensation_blocks, ...lookup_equity_blocks, ...model_compensation_blocks],
  },
  { package: "@domain-libs/contractor", blocks: model_contractor_blocks },
  {
    package: "@domain-libs/employee",
    blocks: [
      ...lookup_capacity_blocks,
      ...lookup_employee_profile_blocks,
      ...lookup_employee_workforce_blocks,
      ...lookup_performance_blocks,
      ...model_employee_blocks,
    ],
  },
  { package: "@domain-libs/org-assignment", blocks: model_org_assignment_blocks },
  { package: "@domain-libs/position", blocks: model_position_blocks },
  { package: "@domain-libs/recruiting", blocks: model_recruiting_blocks },
  { package: "@domain-libs/requisition", blocks: model_requisition_blocks },
  {
    package: "@domain-libs/revenue",
    blocks: [...lookup_revenue_blocks, ...model_revenue_blocks],
  },
  {
    package: "@domain-libs/vendor",
    blocks: [...model_vendor_blocks, ...model_vendor_spend_blocks],
  },
];

const artifact = buildCatalogArtifact(sources);
const actualInventory = Object.values(artifact.domain_catalog.models).map(
  (model) => [model.id, model.source_package] as const,
);
if (JSON.stringify(actualInventory) !== JSON.stringify(EXPECTED_MODEL_INVENTORY)) {
  throw new Error(`domain catalog inventory changed:\n${JSON.stringify(actualInventory, null, 2)}`);
}
const expected = execFileSync("vp", ["fmt", `--stdin-filepath=${outputPath}`], {
  encoding: "utf8",
  input: `${JSON.stringify(artifact, null, 2)}\n`,
});

if (check) {
  const actual = readFileSync(outputPath, "utf8");
  if (actual !== expected) {
    throw new Error("packages/domain-libs/catalog.json is stale; run `mise run schema:compile`");
  }
  console.log(
    `checked ${path.relative(process.cwd(), outputPath)} (${artifact.domain_catalog.model_count} models)`,
  );
} else {
  writeFileSync(outputPath, expected);
  console.log(
    `wrote ${path.relative(process.cwd(), outputPath)} (${artifact.domain_catalog.model_count} models)`,
  );
}
