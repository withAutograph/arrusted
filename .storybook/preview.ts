import type { Preview } from "@storybook/react-vite";
import { bootstrapAgCharts } from "../packages/design-systems/core/compositions/charting/runtime";

import "./preview.css";
import "./storybook.css";

bootstrapAgCharts({ allowMissingLicense: true });

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
  },
};

export default preview;
