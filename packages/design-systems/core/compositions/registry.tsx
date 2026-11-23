import { ActivityFeedComposition } from "./ActivityFeed";
import { validateActivityFeedSpec } from "./ActivityFeed.validation";
import { ChartComposition, KpiStripComposition } from "./Charts";
import { validateChartSpec, validateKpiStripSpec } from "./Charts.validation";
import { DataTableComposition } from "./DataTable";
import { validateDataTableSpec } from "./DataTable.validation";
import { RecordDetailComposition } from "./RecordDetailPanel";
import { validateRecordDetailSpec } from "./RecordDetailPanel.validation";
import { CompositionRegistry, type CompositionRenderer, type CompositionSpec } from "./spec";
import { SchemaFormComposition } from "./SchemaForm";
import { validateSchemaFormSpec } from "./SchemaForm.validation";
import { StepRailComposition } from "./StepRail";
import { validateStepRailSpec } from "./StepRail.validation";
import type { ReactNode } from "react";

export const compositionRegistry = new CompositionRegistry();

function renderValidated<TType extends string, TConfig>(
  Component: (props: { spec: CompositionSpec<TType, TConfig> }) => ReactNode,
): CompositionRenderer<TConfig> {
  return ({ spec }) => {
    // CompositionRegistry validates config before render; this cast localizes
    // the type erasure required by a registry whose renderer API is uniform.
    return <Component spec={spec as CompositionSpec<TType, TConfig>} />;
  };
}

compositionRegistry.register({
  type: "activity_feed",
  description: "Timeline renderer for activity and before/after changes.",
  validate: validateActivityFeedSpec,
  render: renderValidated(ActivityFeedComposition),
});

compositionRegistry.register({
  type: "data_table",
  description: "Presentational table from serializable row and column specs.",
  validate: validateDataTableSpec,
  render: renderValidated(DataTableComposition),
});

compositionRegistry.register({
  type: "record_detail",
  description: "Record detail sections with labeled values, notes, and compact tables.",
  validate: validateRecordDetailSpec,
  render: renderValidated(RecordDetailComposition),
});

compositionRegistry.register({
  type: "chart",
  description:
    "Validated breakdown, timeline, waterfall, scatter, range, donut, combined, and heatmap renderer.",
  validate: validateChartSpec,
  render: renderValidated(ChartComposition),
});

compositionRegistry.register({
  type: "kpi_strip",
  description: "KPI summary strip with optional deltas.",
  validate: validateKpiStripSpec,
  render: renderValidated(KpiStripComposition),
});

compositionRegistry.register({
  type: "step_rail",
  description: "Accordion rail for spec-driven setup, review, and approval steps.",
  validate: validateStepRailSpec,
  render: renderValidated(StepRailComposition),
});

compositionRegistry.register({
  type: "schema_form",
  description: "Form renderer from serializable field specs.",
  validate: validateSchemaFormSpec,
  render: renderValidated(SchemaFormComposition),
});
