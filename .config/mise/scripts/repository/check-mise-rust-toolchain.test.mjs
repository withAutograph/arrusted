import assert from "node:assert/strict";
import test from "node:test";

import { validateMiseRustToolchain } from "./check-mise-rust-toolchain.mjs";

const version = "1.97.1";
const fixture = {
  config: `"rust" = { version = "${version}", profile = "default" }\nRUSTUP_TOOLCHAIN = "${version}"`,
  lock: `[[tools.rust]]\nversion = "${version}"\nbackend = "core:rust"`,
};

test("accepts derived pins matching the mise Rust version", () => {
  assert.doesNotThrow(() => validateMiseRustToolchain(fixture));
});

for (const [name, changed] of [
  ["RUSTUP_TOOLCHAIN", { config: fixture.config.replace(version, "1.98.0") }],
  ["mise lock", { lock: fixture.lock.replace(version, "1.98.0") }],
]) {
  test(`rejects a stale ${name} pin`, () => {
    assert.throws(() => validateMiseRustToolchain({ ...fixture, ...changed }), /authoritative/u);
  });
}
