import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rustToolPattern = /^"rust"\s*=\s*\{[^\n]*\bversion\s*=\s*"([^"]+)"/mu;
const rustupToolchainPattern = /^RUSTUP_TOOLCHAIN\s*=\s*"([^"]+)"/mu;
const lockedRustPattern = /^\[\[tools\.rust\]\]\s*\nversion\s*=\s*"([^"]+)"/mu;

function requiredMatch(source, pattern, label) {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`missing ${label}`);
  return match;
}

export function validateMiseRustToolchain({ config, lock }) {
  const version = requiredMatch(config, rustToolPattern, "mise Rust tool version")[1];
  const rustupVersion = requiredMatch(config, rustupToolchainPattern, "RUSTUP_TOOLCHAIN")[1];
  const lockedVersion = requiredMatch(lock, lockedRustPattern, "locked mise Rust version")[1];

  const mismatches = [
    ["RUSTUP_TOOLCHAIN", rustupVersion],
    ["mise lock", lockedVersion],
  ].filter(([, candidate]) => candidate !== version);
  if (mismatches.length > 0) {
    throw new Error(
      [
        `mise Rust ${version} is authoritative; update every derived pin:`,
        ...mismatches.map(([label, candidate]) => `- ${label}: ${candidate}`),
      ].join("\n"),
    );
  }
}

export async function checkMiseRustToolchain(root = process.cwd()) {
  const [config, lock] = await Promise.all([
    readFile(`${root}/.config/mise/config.toml`, "utf8"),
    readFile(`${root}/.config/mise/mise.lock`, "utf8"),
  ]);
  validateMiseRustToolchain({ config, lock });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkMiseRustToolchain();
}
