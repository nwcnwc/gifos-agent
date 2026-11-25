// A thread of the GifOS core (the VP8 encoder), started only by core-child.cjs's boxed Worker. It inherits the core
// process's permission flags (no file writes, no child processes, file reads of the SDK's dependency folders only), and
// holds the core's code to what the core's own process allows (docs/core-trust.md):
//   - require gives out worker_threads (this thread's port and the core's workerData only) and the VP8 build the SDK
//     resolved, by its exact path; anything else throws by name;
//   - no signals (the permission model does not cover them) and no further threads.
'use strict';
const vm = require('vm');
const wt = require('worker_threads');
const { code, data, libav } = wt.workerData || {};

process.kill = () => { throw new Error('The GifOS core may not signal processes.'); };
try { process._kill = undefined; } catch (e) {}
const NoWorker = function Worker() { throw new Error('A GifOS core thread may not start threads.'); };
Object.defineProperty(wt, 'Worker', { value: NoWorker, writable: false, configurable: false, enumerable: true });
require('module').syncBuiltinESMExports();

const port = Object.freeze({ parentPort: wt.parentPort, workerData: data, isMainThread: false });
function boxedRequire(id) {
  const s = String(id);
  if (s.replace(/^node:/, '') === 'worker_threads') return port;
  if (libav && s === libav) return require(libav);
  throw new Error('A GifOS core thread may not load ' + s + '.');
}
if (typeof code !== 'string') throw new Error('A GifOS core thread needs its code.');
vm.runInThisContext('(function (require) {' + code + '\n})', { filename: 'gifos-core-thread.js' })(boxedRequire);
