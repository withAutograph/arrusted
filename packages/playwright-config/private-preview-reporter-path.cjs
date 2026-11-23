// Playwright may transpile a consumer's configuration to CommonJS. Keep this
// package-relative asset path valid in both that loader and native ESM.
module.exports = require("node:path").join(__dirname, "private-preview-reporter.js");
