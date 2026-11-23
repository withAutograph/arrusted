import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import jsPlugins, { jsPluginSettings } from "ultracite/oxlint/js-plugins";
import next from "ultracite/oxlint/next";
import nextJsPlugins from "ultracite/oxlint/next/js-plugins";

/** Preserve lint options and disabled rules while making Doctor diagnostics advisory. */
export function advisoryReactDoctorConfig(config) {
  if (Array.isArray(config)) return config.map((entry) => advisoryReactDoctorConfig(entry));
  if (config === null || typeof config !== "object") return config;
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (key === "rules" && value !== null && typeof value === "object") {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([rule, setting]) => {
              if (!rule.startsWith("react-doctor/")) return [rule, setting];
              const values = Array.isArray(setting) ? setting : [setting];
              const severity = values[0] === "off" || values[0] === 0 ? values[0] : "warn";
              return [rule, Array.isArray(setting) ? [severity, ...values.slice(1)] : severity];
            }),
          ),
        ];
      }
      return [key, advisoryReactDoctorConfig(value)];
    }),
  );
}

const advisoryJsPlugins = advisoryReactDoctorConfig(jsPlugins);
const advisoryNextJsPlugins = advisoryReactDoctorConfig(nextJsPlugins);

/** Doctor findings share the ordinary lint pass but never become merge gates. */
export function reactDoctorLintDefaults(options = {}) {
  const selected = {
    ...advisoryJsPlugins.rules,
    ...(options.next ? advisoryNextJsPlugins.rules : {}),
  };
  return {
    jsPlugins: [{ name: "react-doctor", specifier: "oxlint-plugin-react-doctor" }],
    settings: jsPluginSettings,
    rules: Object.fromEntries(
      Object.entries(selected).filter(([name]) => name.startsWith("react-doctor/")),
    ),
  };
}

export function nextAppOxlintDefaults(options = {}) {
  return {
    extends: [core, next, advisoryJsPlugins, advisoryNextJsPlugins, antiSlop],
    ignorePatterns: [
      ...(core.ignorePatterns ?? []),
      "schema/index.ts",
      "schema/release/**",
      ...(options.ignorePatterns ?? []),
    ],
    jsPlugins: jsPlugins.jsPlugins,
    options: { typeAware: true },
    settings: jsPluginSettings,
    rules: reactDoctorLintDefaults({ next: true }).rules,
  };
}
