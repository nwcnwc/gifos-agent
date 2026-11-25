// The one switch for core mode (joining with no browser: the meeting's signed core in a sandboxed child process).
// Core mode is on. This constant stays as the one switch: the core tests are skip-gated on it (they run when it is
// true) and test/unit/core-off.test.js skips itself, so flipping it needs no other test change.
export const CORE_MODE = true;
export const CORE_MODE_OFF = "Core mode (joining without a browser) isn't available yet; join without { core: true }.";
