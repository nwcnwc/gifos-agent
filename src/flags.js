// The one switch for core mode (joining with no browser: the meeting's signed core in a sandboxed child process).
// Core mode is opt-in for now: set GIFOS_CORE_MODE=1 in the environment of the process that joins. It stays off by
// default while one known media gap is open (in an all-Node deep chain, a deep seat's mix can miss one Section-1 row's
// voice). The core tests are skip-gated on it (they run with GIFOS_CORE_MODE=1) and test/unit/core-off.test.js runs
// when it is off, so turning it on by default later is one line here.
export const CORE_MODE = (typeof process !== 'undefined' && process.env && process.env.GIFOS_CORE_MODE === '1');
export const CORE_MODE_OFF = "Core mode (joining without a browser) is opt-in for now: set GIFOS_CORE_MODE=1, or join without { core: true }.";
