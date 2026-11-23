import { createPlaywrightConfig } from "./config.js";

export { createPlaywrightConfig } from "./config.js";
export const playwrightWebServerPort = process.env.PLAYWRIGHT_WEB_SERVER_PORT ?? "4100";

export default createPlaywrightConfig();
