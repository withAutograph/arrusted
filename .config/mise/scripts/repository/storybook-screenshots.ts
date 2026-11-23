// Capture rendered Storybook story screenshots for visual proof.
// Storybook must be running on :6006 (`mise --cd .storybook dev`).
// Output goes to `.scratch/screenshots` (gitignored).
// Set `CAPTURE_PATTERN` to a regular expression matching story IDs when a
// change needs focused proof instead of the complete historical sweep.
//
// Add a new entry to CAPTURES below for each story you want to capture.
// Story IDs follow the pattern: <kebab-cased-title>--<kebab-cased-export-name>.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = "http://127.0.0.1:6006";
// `OUT` defaults to `.scratch/screenshots`; pass an env override
// (`OUT=.scratch/screenshots-pr53-part2`) to capture into a part-specific
// subdir without polluting the default sweep.
const OUT = process.env.OUT ?? ".scratch/screenshots";

type Capture = {
  file: string;
  storyId: string;
  width?: number;
  height?: number;
  // Optional setup steps after navigation. selector targets within #storybook-root.
  steps?: Array<
    | { type: "click"; selector: string }
    | { type: "hover"; selector: string }
    | { type: "viewport"; width: number; height: number }
    | { type: "wait"; ms: number }
    | { type: "press"; key: string; selector?: string }
    | { type: "scroll"; top: number }
    | { type: "back" }
  >;
};

const CAPTURES: Capture[] = [
  {
    file: "record-detail-read-only.png",
    storyId: "design-system-compositions-record-detail-panel--read-only",
    width: 760,
    height: 900,
  },
  {
    file: "record-detail-editable.png",
    storyId: "design-system-compositions-record-detail-panel--editable",
    width: 820,
    height: 980,
  },
  {
    file: "record-detail-field-changes.png",
    storyId: "design-system-compositions-record-detail-panel--with-field-changes",
    width: 820,
    height: 980,
    steps: [{ type: "scroll", top: 0 }],
  },
  {
    file: "record-detail-edit-mode.png",
    storyId: "design-system-compositions-record-detail-panel--editable",
    width: 820,
    height: 980,
    steps: [
      { type: "click", selector: "article > header button:not([aria-label])" },
      { type: "scroll", top: 0 },
    ],
  },
  {
    file: "record-detail-narrow-editable.png",
    storyId: "design-system-compositions-record-detail-panel--narrow-editable",
    width: 420,
    height: 900,
  },
  {
    file: "record-detail-in-sheet.png",
    storyId: "design-system-compositions-record-detail-panel--in-sheet",
    width: 1280,
    height: 900,
  },
  {
    file: "record-detail-narrow.png",
    storyId: "design-system-compositions-record-detail-panel--narrow",
    width: 420,
    height: 900,
  },
  {
    file: "record-detail-scrollable.png",
    storyId: "design-system-compositions-record-detail-panel--scrollable",
    width: 680,
    height: 760,
  },
  {
    file: "01-icons-catalog.png",
    storyId: "design-system-foundations-icons--catalog",
    width: 900,
    height: 600,
  },
  {
    file: "02-money-rate-default.png",
    storyId: "design-system-editors-moneyrateeditor--with-annual-usd",
    width: 760,
    height: 320,
  },
  {
    file: "03-money-rate-math-expression.png",
    storyId: "design-system-editors-moneyrateeditor--math-expression-plus-5-percent",
    width: 760,
    height: 320,
  },
  {
    file: "03b-money-rate-math-add-subtract.png",
    storyId: "design-system-editors-moneyrateeditor--math-expression-add-subtract",
    width: 760,
    height: 320,
  },
  {
    file: "04-date-picker-closed.png",
    storyId: "design-system-controls-datepickercalendar--with-date",
    width: 540,
    height: 200,
  },
  {
    file: "05-date-picker-month-year.png",
    storyId: "design-system-controls-datepickercalendar--with-date",
    width: 540,
    height: 460,
    steps: [
      { type: "click", selector: "button[aria-label='Choose month and year']" },
      { type: "wait", ms: 200 },
    ],
  },
  {
    file: "06-as-of-date-pill-closed.png",
    storyId: "design-system-controls-asofdatepill--default",
    width: 540,
    height: 200,
  },
  {
    file: "07-as-of-date-pill-open.png",
    storyId: "design-system-controls-asofdatepill--default",
    width: 560,
    height: 540,
    steps: [
      { type: "click", selector: "button[aria-haspopup='dialog']" },
      { type: "wait", ms: 200 },
    ],
  },
  {
    file: "08-primitives-display.png",
    storyId: "design-system-primitives--display",
    width: 900,
    height: 360,
  },
  {
    file: "08b-primitives-form-controls.png",
    storyId: "design-system-primitives--form-controls",
    width: 1000,
    height: 760,
  },
  {
    file: "09-data-surface-empty.png",
    storyId: "design-system-compositions-datasurface--empty",
    width: 1100,
    height: 460,
  },
  {
    file: "10-data-surface-populated.png",
    storyId: "design-system-compositions-datasurface--populated",
    width: 1100,
    height: 620,
  },
  {
    file: "11-data-surface-virtualized.png",
    storyId: "design-system-compositions-datasurface--virtualized",
    width: 1100,
    height: 620,
  },
  {
    file: "12-data-surface-with-toolbar.png",
    storyId: "design-system-compositions-datasurface--with-toolbar",
    width: 1100,
    height: 620,
  },
  {
    file: "13-data-surface-loading.png",
    storyId: "design-system-compositions-datasurface--loading",
    width: 1100,
    height: 460,
  },
  {
    file: "14-data-surface-tall.png",
    storyId: "design-system-compositions-datasurface--tall",
    width: 1100,
    height: 880,
  },
  {
    file: "15-data-surface-long-content.png",
    storyId: "design-system-compositions-datasurface--long-content",
    width: 1100,
    height: 420,
  },
  {
    file: "16-data-surface-horizontal-scroll.png",
    storyId: "design-system-compositions-datasurface--horizontal-scroll",
    width: 900,
    height: 460,
  },
  {
    file: "20-editable-grid-readonly.png",
    storyId: "modules-editablerowversiongrid--read-only-mode",
    width: 1100,
    height: 520,
  },
  {
    file: "21-editable-grid-tracked-edit.png",
    storyId: "modules-editablerowversiongrid--tracked-editing",
    width: 1100,
    height: 580,
    // Open the editor on the first row's Title cell, commit, then re-open
    // a different cell so the screenshot shows BOTH the active editor and
    // the submit dock with "1 edit pending".
    steps: [
      { type: "click", selector: "[data-cell-row='it-001'][data-cell-column='title']" },
      { type: "wait", ms: 150 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 150 },
      { type: "click", selector: "[data-cell-row='it-002'][data-cell-column='title']" },
      { type: "wait", ms: 250 },
    ],
  },
  {
    file: "22-editable-grid-direct.png",
    storyId: "modules-editablerowversiongrid--direct-editing",
    width: 1100,
    height: 520,
  },
  {
    file: "23-editable-grid-multiple-edits.png",
    storyId: "modules-editablerowversiongrid--multiple-edits",
    width: 1100,
    height: 580,
    // Commit three quick edits across three rows so the dock shows
    // "3 edits pending".
    steps: [
      { type: "click", selector: "[data-cell-row='it-001'][data-cell-column='title']" },
      { type: "wait", ms: 120 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 120 },
      { type: "click", selector: "[data-cell-row='it-002'][data-cell-column='title']" },
      { type: "wait", ms: 120 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 120 },
      { type: "click", selector: "[data-cell-row='it-003'][data-cell-column='title']" },
      { type: "wait", ms: 120 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 200 },
    ],
  },
  {
    file: "24-editable-grid-apply-success.png",
    storyId: "modules-editablerowversiongrid--apply-success",
    width: 1100,
    height: 580,
    // Commit one edit then click Save; capture after the dock clears.
    steps: [
      { type: "click", selector: "[data-cell-row='it-001'][data-cell-column='title']" },
      { type: "wait", ms: 120 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 250 },
      { type: "click", selector: "[data-dock='submit'] button" },
      { type: "wait", ms: 400 },
    ],
  },
  {
    file: "23b-editable-grid-undo-clicked.png",
    storyId: "modules-editablerowversiongrid--multiple-edits",
    width: 1100,
    height: 580,
    // Build up 3 dirty cells, then click the undo on row 1 — dock should
    // drop from "3 edits pending" to "2 edits pending" without an apply.
    steps: [
      { type: "click", selector: "[data-cell-row='it-001'][data-cell-column='title']" },
      { type: "wait", ms: 120 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 120 },
      { type: "click", selector: "[data-cell-row='it-002'][data-cell-column='title']" },
      { type: "wait", ms: 120 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 120 },
      { type: "click", selector: "[data-cell-row='it-003'][data-cell-column='title']" },
      { type: "wait", ms: 120 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 250 },
      {
        type: "click",
        selector: "[data-cell-row='it-001'][data-cell-column='title'] [data-cell-undo]",
      },
      { type: "wait", ms: 200 },
    ],
  },
  {
    file: "26-editable-grid-apps-dev-shape.png",
    storyId: "modules-editablerowversiongrid--apps-dev-shape",
    width: 1100,
    height: 620,
    // Open one cell, commit, then re-click another so both editor + dock
    // are visible — closest visual proof to apps/dev under substrate.
    steps: [
      { type: "click", selector: "[data-cell-row='it-001'][data-cell-column='title']" },
      { type: "wait", ms: 150 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 150 },
      { type: "click", selector: "[data-cell-row='it-002'][data-cell-column='score']" },
      { type: "wait", ms: 250 },
    ],
  },
  {
    file: "25-editable-grid-apply-error.png",
    storyId: "modules-editablerowversiongrid--apply-error",
    width: 1100,
    height: 620,
    steps: [
      { type: "click", selector: "[data-cell-row='it-001'][data-cell-column='title']" },
      { type: "wait", ms: 120 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 250 },
      { type: "click", selector: "[data-dock='submit'] button" },
      { type: "wait", ms: 400 },
    ],
  },
  {
    file: "30-org-chart-node-card.png",
    storyId: "org-chart-nodecard--accent-palette",
    width: 720,
    height: 420,
  },
  {
    file: "31-org-chart-canvas-default.png",
    storyId: "org-chart-canvas--default",
    width: 1440,
    height: 900,
  },
  {
    file: "32-org-chart-canvas-expanded.png",
    storyId: "org-chart-canvas--expand-all",
    width: 1440,
    height: 900,
    steps: [{ type: "wait", ms: 500 }],
  },
  {
    file: "33-org-chart-canvas-focused.png",
    storyId: "org-chart-canvas--focused",
    width: 1440,
    height: 900,
  },
  {
    file: "34-org-chart-canvas-search-dim.png",
    storyId: "org-chart-canvas--search-dim",
    width: 1440,
    height: 900,
  },
  {
    file: "35-org-chart-composition-default.png",
    storyId: "org-chart-composition--default",
    width: 1440,
    height: 900,
  },
  {
    file: "36-org-chart-composition-search.png",
    storyId: "org-chart-composition--search-active",
    width: 1440,
    height: 900,
    steps: [{ type: "wait", ms: 200 }],
  },
  {
    file: "37-org-chart-composition-no-match.png",
    storyId: "org-chart-composition--no-match-search",
    width: 1440,
    height: 900,
    steps: [{ type: "wait", ms: 200 }],
  },
  {
    file: "38-org-chart-label-states.png",
    storyId: "org-chart-nodecard-label--state-sheet",
    width: 1100,
    height: 300,
    // Let the pending pulse settle on a frame; the sheet is otherwise static.
    steps: [{ type: "wait", ms: 100 }],
  },
  {
    file: "38b-org-chart-label-hover.png",
    storyId: "org-chart-nodecard-label--interactive",
    width: 820,
    height: 160,
    steps: [{ type: "hover", selector: "[data-story-card='hover']" }],
  },
  {
    file: "38c-org-chart-label-focus-visible.png",
    storyId: "org-chart-nodecard-label--interactive",
    width: 820,
    height: 160,
    steps: [
      { type: "press", key: "Tab" },
      { type: "press", key: "Tab" },
    ],
  },
  {
    file: "39-org-chart-direction-ltr.png",
    storyId: "org-chart-direction--left-to-right",
    width: 820,
    height: 460,
  },
  {
    file: "39b-org-chart-direction-rtl.png",
    storyId: "org-chart-direction--right-to-left",
    width: 820,
    height: 460,
  },
  {
    file: "39c-org-chart-direction-ttb.png",
    storyId: "org-chart-direction--top-to-bottom",
    width: 820,
    height: 460,
  },
  {
    file: "39a-schema-employee-wide.png",
    storyId: "org-chart-relationgraph--schema-employee",
    width: 1200,
    height: 640,
  },
  {
    file: "39a-schema-employee-narrow.png",
    storyId: "org-chart-relationgraph--schema-employee",
    width: 800,
    height: 640,
  },
  {
    file: "39b-record-employee-wide.png",
    storyId: "org-chart-relationgraph--record-employee",
    width: 1200,
    height: 640,
  },
  {
    file: "39b-record-employee-narrow.png",
    storyId: "org-chart-relationgraph--record-employee",
    width: 800,
    height: 640,
  },
  {
    file: "39c-record-many-reports-wide.png",
    storyId: "org-chart-relationgraph--record-employee-many-reports",
    width: 1200,
    height: 640,
  },
  {
    file: "39c-record-many-reports-narrow.png",
    storyId: "org-chart-relationgraph--record-employee-many-reports",
    width: 800,
    height: 640,
  },
  {
    file: "39d-record-department-wide.png",
    storyId: "org-chart-relationgraph--record-department",
    width: 1200,
    height: 640,
  },
  {
    file: "39d-record-department-narrow.png",
    storyId: "org-chart-relationgraph--record-department",
    width: 800,
    height: 640,
  },
  {
    file: "39e-record-position-wide.png",
    storyId: "org-chart-relationgraph--record-position",
    width: 1200,
    height: 640,
  },
  {
    file: "39e-record-position-narrow.png",
    storyId: "org-chart-relationgraph--record-position",
    width: 800,
    height: 640,
  },
  {
    file: "39f-pending-wide.png",
    storyId: "org-chart-relationgraph--pending",
    width: 1200,
    height: 640,
  },
  {
    file: "39f-pending-narrow.png",
    storyId: "org-chart-relationgraph--pending",
    width: 800,
    height: 640,
  },
  {
    file: "39j-record-many-columns-wide.png",
    storyId: "org-chart-relationgraph--record-employee-many-columns",
    width: 1200,
    height: 640,
  },
  {
    file: "39j-record-many-columns-narrow.png",
    storyId: "org-chart-relationgraph--record-employee-many-columns",
    width: 800,
    height: 640,
  },
  {
    // Mounted wide, then narrowed: the graph re-fits to the new size.
    file: "39k-resize-refit-1200-to-800.png",
    storyId: "org-chart-relationgraph--record-employee-many-columns",
    width: 1200,
    height: 640,
    steps: [
      { type: "viewport", width: 800, height: 640 },
      { type: "wait", ms: 400 },
    ],
  },
  {
    file: "39g-recentre-after-click-wide.png",
    storyId: "org-chart-relationgraph--recentre",
    width: 1200,
    height: 640,
    steps: [
      { type: "click", selector: "[aria-label='Activate Manager: Ann Veal']" },
      // Park the pointer on the (inert) centre so no card shows hover.
      { type: "hover", selector: "[aria-current='true']" },
      { type: "wait", ms: 300 },
    ],
  },
  {
    file: "39g-recentre-after-click-narrow.png",
    storyId: "org-chart-relationgraph--recentre",
    width: 800,
    height: 640,
    steps: [
      { type: "click", selector: "[aria-label='Activate Manager: Ann Veal']" },
      // Park the pointer on the (inert) centre so no card shows hover.
      { type: "hover", selector: "[aria-current='true']" },
      { type: "wait", ms: 300 },
    ],
  },
  {
    file: "39h-record-employee-hover.png",
    storyId: "org-chart-relationgraph--record-employee",
    width: 1200,
    height: 640,
    steps: [{ type: "hover", selector: "[aria-label='Activate Department: Engineering']" }],
  },
  {
    file: "39i-record-employee-focus.png",
    storyId: "org-chart-relationgraph--record-employee",
    width: 1200,
    height: 640,
    steps: [
      { type: "press", key: "Tab" },
      { type: "press", key: "Tab" },
      { type: "press", key: "Tab" },
    ],
  },
  ...(
    [
      ["39l-framed-record-employee", "org-chart-relationgraph--framed-record-employee"],
      ["39m-framed-schema-employee", "org-chart-relationgraph--framed-schema-employee"],
      ["39n-framed-record-position", "org-chart-relationgraph--framed-record-position"],
      ["39o-framed-below", "org-chart-relationgraph--framed-below"],
    ] as const
  ).flatMap(([name, storyId]) => [
    { file: `${name}-wide.png`, storyId, width: 1200, height: 640 },
    { file: `${name}-narrow.png`, storyId, width: 800, height: 640 },
  ]),
  ...(
    [
      ["44a-explore-landing", "hc-explore--landing"],
      ["44a-explore-landing-browse-open", "hc-explore--landing-browse-open"],
      ["44b-explore-model-employee", "hc-explore--model-employee"],
      ["44c-explore-model-employee-filtered", "hc-explore--model-employee-filtered"],
      ["44d-explore-model-org-assignment", "hc-explore--model-org-assignment"],
      ["44e-explore-record-employee", "hc-explore--record-employee"],
      ["44f-explore-record-position", "hc-explore--record-position"],
      ["44g-explore-record-department", "hc-explore--record-department"],
    ] as const
  ).flatMap(([name, storyId]) => [
    // Let the graph's debounced resize re-fit settle before capturing.
    ...[1200, 800].map((width) => ({
      file: `${name}-${width === 1200 ? "wide" : "narrow"}.png`,
      storyId,
      width,
      height: 900,
      steps: [{ type: "wait" as const, ms: 400 }],
    })),
  ]),
  // The real ExplorePage over a fake HC API (see explore-page.stories.tsx).
  ...(
    [
      ["45a-explore-page-landing", "hc-explore-page--landing", []],
      [
        "45b-explore-page-landing-browse",
        "hc-explore-page--landing",
        [{ type: "click", selector: "button[aria-controls]" }],
      ],
      ["45c-explore-page-model-employee", "hc-explore-page--model-employee", []],
      ["45d-explore-page-record-employee", "hc-explore-page--record-employee", []],
      ["45e-explore-page-record-position", "hc-explore-page--record-position", []],
      ["45f-explore-page-record-department", "hc-explore-page--record-department", []],
      ["45g-explore-page-record-org-assignment", "hc-explore-page--record-org-assignment", []],
      [
        "45h-explore-page-more-filtered",
        "hc-explore-page--record-employee",
        [
          { type: "wait", ms: 600 },
          { type: "click", selector: "[aria-label='Activate +2 more']" },
        ],
      ],
      [
        "45i-explore-page-recentred",
        "hc-explore-page--record-employee",
        [
          { type: "wait", ms: 600 },
          { type: "click", selector: "[aria-label='Activate Manager: Ann Veal']" },
        ],
      ],
      // Captured while the opened column is still tinted.
      ["45k-explore-page-field-hit", "hc-explore-page--field-hit", []],
      [
        "45j-explore-page-back-after-recentre",
        "hc-explore-page--record-employee",
        [
          { type: "wait", ms: 600 },
          { type: "click", selector: "[aria-label='Activate Manager: Ann Veal']" },
          { type: "wait", ms: 600 },
          { type: "back" },
        ],
      ],
    ] as const
  ).flatMap(([name, storyId, steps]) =>
    [1200, 800].map((width) => ({
      file: `${name}-${width === 1200 ? "wide" : "narrow"}.png`,
      storyId,
      width,
      height: 900,
      steps: [...steps, { type: "wait" as const, ms: 700 }] as Capture["steps"],
    })),
  ),
  // The record page tall enough to show the History panel below the fields:
  // Jane has fixture history, the department has none.
  ...(
    [
      ["45l-explore-page-history-populated", "hc-explore-page--record-employee"],
      ["45m-explore-page-history-empty", "hc-explore-page--record-department"],
    ] as const
  ).map(([name, storyId]) => ({
    file: `${name}.png`,
    storyId,
    width: 1200,
    height: 3200,
    steps: [{ type: "wait" as const, ms: 900 }],
  })),
  // Explore search states in the landing box and the Jump modal
  // (see explore-search.stories.tsx).
  ...(
    [
      ["46a-explore-search-landing-grouped", "hc-explore-search--landing-grouped", []],
      ["46b-explore-search-landing-records", "hc-explore-search--landing-records", []],
      ["46b-explore-search-landing-reference", "hc-explore-search--landing-reference", []],
      ["46c-explore-search-landing-loading", "hc-explore-search--landing-loading", []],
      ["46d-explore-search-landing-no-results", "hc-explore-search--landing-no-results", []],
      ["46e-explore-search-landing-load-error", "hc-explore-search--landing-load-error", []],
      [
        "46f-explore-search-landing-keyboard",
        "hc-explore-search--landing-records",
        [
          { type: "press", key: "ArrowDown", selector: "#explore-search" },
          { type: "press", key: "ArrowDown" },
        ],
      ],
      ["46g-explore-search-jump-grouped", "hc-explore-search--jump-grouped", []],
      ["46h-explore-search-jump-records", "hc-explore-search--jump-records", []],
      ["46i-explore-search-jump-loading", "hc-explore-search--jump-loading", []],
      ["46j-explore-search-jump-no-results", "hc-explore-search--jump-no-results", []],
      ["46k-explore-search-jump-load-error", "hc-explore-search--jump-load-error", []],
      [
        "46l-explore-search-jump-keyboard",
        "hc-explore-search--jump-records",
        [
          { type: "press", key: "ArrowDown", selector: "#explore-jump" },
          { type: "press", key: "ArrowDown" },
        ],
      ],
    ] as const
  ).flatMap(([name, storyId, steps]) =>
    [1200, 800].map((width) => ({
      file: `${name}-${width === 1200 ? "wide" : "narrow"}.png`,
      storyId,
      width,
      height: 900,
      steps: [...steps, { type: "wait" as const, ms: 300 }] as Capture["steps"],
    })),
  ),
  // Record search on the real ExplorePage over the fake HC API: typing on
  // the landing loads the search batch; a record hit opens its page.
  ...(() => {
    const typeJane = [
      { type: "press", key: "j", selector: "#explore-search" },
      { type: "press", key: "a" },
      { type: "press", key: "n" },
      { type: "press", key: "e" },
      { type: "wait", ms: 700 },
    ] as const;
    const openJane = [
      ...typeJane,
      { type: "click", selector: "[role='option'][aria-label^='record Jane Doe']" },
      { type: "wait", ms: 900 },
    ] as const;
    const jumpAnn = [
      { type: "wait", ms: 900 },
      { type: "click", selector: "button:has-text('Jump · ⌘K')" },
      { type: "press", key: "a", selector: "#explore-jump" },
      { type: "press", key: "n" },
      { type: "press", key: "n" },
      { type: "wait", ms: 700 },
    ] as const;
    return (
      [
        ["47a-explore-page-search-jane", "hc-explore-page--landing", typeJane],
        ["47b-explore-page-search-opened-jane", "hc-explore-page--landing", openJane],
        [
          "47c-explore-page-search-back",
          "hc-explore-page--landing",
          [...openJane, { type: "back" }, { type: "wait", ms: 600 }],
        ],
        ["47d-explore-page-jump-ann", "hc-explore-page--record-employee", jumpAnn],
      ] as const
    ).flatMap(([name, storyId, steps]) =>
      [1200, 800].map((width) => ({
        file: `${name}-${width === 1200 ? "wide" : "narrow"}.png`,
        storyId,
        width,
        height: 900,
        steps: [...steps] as Capture["steps"],
      })),
    );
  })(),
  // The per-field swimlane timeline (see explore-swimlanes.stories.tsx).
  ...(
    [
      ["48a-explore-swimlanes-populated", "hc-explore-swimlanes--populated", []],
      ["48b-explore-swimlanes-marker-in-middle", "hc-explore-swimlanes--marker-in-middle", []],
      ["48c-explore-swimlanes-single-lane", "hc-explore-swimlanes--single-lane", []],
      ["48d-explore-swimlanes-empty", "hc-explore-swimlanes--empty", []],
      // The marker stepped back one change date with the keyboard.
      [
        "48e-explore-swimlanes-keyboard-scrub",
        "hc-explore-swimlanes--marker-in-middle",
        [{ type: "press", key: "ArrowLeft", selector: "input[type='range']" }],
      ],
      // A change scheduled after today, on the padded axis.
      ["48f-explore-swimlanes-future-change", "hc-explore-swimlanes--future-change", []],
    ] as const
  ).flatMap(([name, storyId, steps]) =>
    [1200, 800].map((width) => ({
      file: `${name}-${width === 1200 ? "wide" : "narrow"}.png`,
      storyId,
      width,
      height: 420,
      steps: [...steps] as Capture["steps"],
    })),
  ),
  {
    file: "39p-framed-caption-hover.png",
    storyId: "org-chart-relationgraph--framed-caption-states",
    width: 1200,
    height: 640,
    steps: [{ type: "hover", selector: "[aria-label='Open Org Assignment']" }],
  },
  {
    // The caption is the first stop in tab order, ahead of its own cards.
    file: "39q-framed-caption-focus.png",
    storyId: "org-chart-relationgraph--framed-caption-states",
    width: 1200,
    height: 640,
    steps: [{ type: "press", key: "Tab" }],
  },
  {
    file: "40-page-tabs-default.png",
    storyId: "design-system-controls-pagetabs--default",
    width: 1000,
    height: 220,
    // Defer one frame past the rAF inside PageTabs so the measured
    // indicator has its first non-zero width when we screenshot.
    steps: [{ type: "wait", ms: 150 }],
  },
  {
    file: "41-page-tabs-default-second-active.png",
    storyId: "design-system-controls-pagetabs--default",
    width: 1000,
    height: 220,
    // Click the "Second" tab so the screenshot proves the indicator
    // translates AND widens to the second button's measured rect.
    steps: [
      { type: "wait", ms: 150 },
      { type: "click", selector: "[data-page-tab='second']" },
      { type: "wait", ms: 300 },
    ],
  },
  {
    file: "42-page-tabs-single-option.png",
    storyId: "design-system-controls-pagetabs--single-option",
    width: 1000,
    height: 220,
    steps: [{ type: "wait", ms: 150 }],
  },
  {
    file: "43-page-tabs-many.png",
    storyId: "design-system-controls-pagetabs--many-tabs",
    width: 1000,
    height: 220,
    steps: [{ type: "wait", ms: 150 }],
  },
  // Tenant custom fields as ordinary editable-grid columns.
  {
    file: "46a-grid-custom-field-columns.png",
    storyId: "editable-grid-custom-field-columns--columns",
    width: 2160,
    height: 400,
    steps: [{ type: "wait", ms: 600 }],
  },
  {
    file: "46b-grid-custom-field-pending-edits.png",
    storyId: "editable-grid-custom-field-columns--pending-edits",
    width: 2160,
    height: 400,
    steps: [{ type: "wait", ms: 600 }],
  },
  {
    file: "46c-grid-custom-field-choice-editor.png",
    storyId: "editable-grid-custom-field-columns--columns",
    width: 2160,
    height: 400,
    steps: [
      { type: "wait", ms: 600 },
      { type: "press", key: "Enter", selector: "[row-id='w-2'] [col-id='cf_tier']" },
      { type: "wait", ms: 300 },
    ],
  },
  {
    file: "46d-grid-custom-field-link-editor.png",
    storyId: "editable-grid-custom-field-columns--columns",
    width: 2160,
    height: 400,
    steps: [
      { type: "wait", ms: 600 },
      { type: "press", key: "Enter", selector: "[row-id='w-1'] [col-id='cf_owner']" },
      { type: "wait", ms: 300 },
    ],
  },
  // Date-and-time and list-of-text cells: closed, pending, and each editor open.
  {
    file: "49a-grid-datetime-list-columns.png",
    storyId: "editable-grid-date-time-and-list-columns--columns",
    width: 1280,
    height: 620,
    steps: [{ type: "wait", ms: 600 }],
  },
  {
    file: "49b-grid-datetime-list-pending-edits.png",
    storyId: "editable-grid-date-time-and-list-columns--pending-edits",
    width: 1280,
    height: 620,
    steps: [{ type: "wait", ms: 600 }],
  },
  {
    file: "49c-grid-datetime-editor-open.png",
    storyId: "editable-grid-date-time-and-list-columns--columns",
    width: 1280,
    height: 620,
    steps: [
      { type: "wait", ms: 600 },
      { type: "press", key: "Enter", selector: "[row-id='w-1'] [col-id='cf_inspected']" },
      { type: "wait", ms: 300 },
    ],
  },
  {
    file: "49d-grid-datetime-editor-required-open.png",
    storyId: "editable-grid-date-time-and-list-columns--columns",
    width: 1280,
    height: 620,
    steps: [
      { type: "wait", ms: 600 },
      { type: "press", key: "Enter", selector: "[row-id='w-1'] [col-id='checked_at']" },
      { type: "wait", ms: 300 },
    ],
  },
  {
    file: "49e-grid-text-list-editor-open.png",
    storyId: "editable-grid-date-time-and-list-columns--columns",
    width: 1280,
    height: 620,
    steps: [
      { type: "wait", ms: 600 },
      { type: "press", key: "Enter", selector: "[row-id='w-1'] [col-id='cf_tags']" },
      { type: "wait", ms: 300 },
    ],
  },
  {
    file: "49f-grid-text-list-editor-empty-open.png",
    storyId: "editable-grid-date-time-and-list-columns--columns",
    width: 1280,
    height: 620,
    steps: [
      { type: "wait", ms: 600 },
      { type: "press", key: "Enter", selector: "[row-id='w-3'] [col-id='cf_tags']" },
      { type: "wait", ms: 300 },
    ],
  },
  // The real Positions page with tenant custom fields as columns.
  {
    file: "48a-positions-page-custom-fields.png",
    storyId: "hc-positions-page--with-custom-fields",
    width: 1600,
    height: 520,
    steps: [
      { type: "wait", ms: 1200 },
      { type: "scroll", top: 0 },
    ],
  },
  {
    // Focus the first row and jump to its last column, where custom fields sit.
    file: "48b-positions-page-custom-columns.png",
    storyId: "hc-positions-page--with-custom-fields",
    width: 1600,
    height: 520,
    steps: [
      { type: "wait", ms: 1200 },
      { type: "click", selector: ".ag-center-cols-container .ag-row[row-index='0'] .ag-cell" },
      { type: "press", key: "End" },
      { type: "wait", ms: 400 },
    ],
  },
  {
    file: "48c-positions-page-link-picker-clear.png",
    storyId: "hc-positions-page--with-custom-fields",
    width: 1600,
    height: 620,
    steps: [
      { type: "wait", ms: 1200 },
      { type: "click", selector: ".ag-center-cols-container .ag-row[row-index='0'] .ag-cell" },
      { type: "press", key: "End" },
      { type: "wait", ms: 300 },
      { type: "press", key: "Enter" },
      { type: "wait", ms: 400 },
    ],
  },
  // Schema administration: adding a tenant custom field.
  ...(
    [
      ["47a-custom-field-form-text", "hc-schema-administration-custom-field-form--text", []],
      ["47b-custom-field-form-choice", "hc-schema-administration-custom-field-form--choice", []],
      [
        "47c-custom-field-form-link",
        "hc-schema-administration-custom-field-form--link-to-record",
        [],
      ],
      [
        "47d-custom-field-form-choice-errors",
        "hc-schema-administration-custom-field-form--choice-errors",
        [{ type: "click", selector: "button[type='submit']" }],
      ],
      [
        "47e-custom-field-form-link-errors",
        "hc-schema-administration-custom-field-form--link-errors",
        [{ type: "click", selector: "button[type='submit']" }],
      ],
    ] as const
  ).flatMap(([name, storyId, steps]) =>
    [1100, 420].map((width) => ({
      file: `${name}-${width === 1100 ? "wide" : "narrow"}.png`,
      storyId,
      width,
      height: width === 1100 ? 520 : 820,
      steps: [...steps, { type: "wait" as const, ms: 200 }] as Capture["steps"],
    })),
  ),
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const capturePattern = process.env.CAPTURE_PATTERN;
  const captures = capturePattern
    ? CAPTURES.filter(({ storyId }) => new RegExp(capturePattern, "u").test(storyId))
    : CAPTURES;
  if (captures.length === 0) {
    throw new Error(`CAPTURE_PATTERN matched no Storybook stories: ${capturePattern}`);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let failures = 0;
  for (const cap of captures) {
    const page = await context.newPage();
    const url = `${BASE}/iframe.html?id=${cap.storyId}&viewMode=story`;
    try {
      // Size the page before the story mounts so canvases that fit to their
      // container on mount fit to the captured size, not the default.
      await page.setViewportSize({
        width: cap.width ?? 1280,
        height: cap.height ?? 800,
      });
      // Storybook's dev client keeps its HMR/event connection open, so
      // `networkidle` is not a stable readiness signal. The rendered root is
      // the proof target and gives every story the same deterministic gate.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      // Sheet stories render through a portal, leaving Storybook's root empty.
      // Wait for content in either the normal canvas or an open dialog.
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector("#storybook-root")?.childElementCount) ||
          Boolean(document.querySelector('dialog[open], [role="dialog"]')),
        { timeout: 5000 },
      );
      await page.setViewportSize({
        width: cap.width ?? 1280,
        height: cap.height ?? 800,
      });
      await page.waitForTimeout(150);
      for (const step of cap.steps ?? []) {
        if (step.type === "click") {
          await page.click(step.selector);
        } else if (step.type === "hover") {
          await page.hover(step.selector);
        } else if (step.type === "viewport") {
          await page.setViewportSize({ width: step.width, height: step.height });
        } else if (step.type === "wait") {
          await page.waitForTimeout(step.ms);
        } else if (step.type === "press") {
          if (step.selector) await page.focus(step.selector);
          await page.keyboard.press(step.key);
        } else if (step.type === "scroll") {
          await page.evaluate((top) => window.scrollTo({ top }), step.top);
        } else if (step.type === "back") {
          // A hash route change is in-document history, so go back in-page.
          await page.evaluate(() => window.history.back());
        }
      }
      await page.screenshot({ path: `${OUT}/${cap.file}`, fullPage: false });
      console.log(`OK  ${cap.file} -> ${url}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${cap.file} -> ${url}: ${(error as Error).message}`);
    } finally {
      await page.close();
    }
  }
  await browser.close();
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
