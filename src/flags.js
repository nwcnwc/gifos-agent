// The one switch for core mode (joining with no browser: the meeting's signed core in a sandboxed child process).
// Off in the published package: a seat with no browser ships only once it can carry voice and video, and the core code
// stays here until then. To turn it on: set CORE_MODE = true. The core tests are skip-gated on this constant (they run
// again by themselves) and test/unit/core-off.test.js skips itself, so flipping it needs no other test change.
export const CORE_MODE = false;
export const CORE_MODE_OFF = "Core mode (joining without a browser) isn't available yet; join without { core: true }.";
