// Worker thread: reads tags for a list of files and posts the results back.
// Runs on its own event loop, so scanning thousands of files never stalls the main process.

const { parentPort } = require('worker_threads');
const { parseTrack } = require('./tags');

const CONCURRENCY = 6;

parentPort.on('message', async ({ id, jobs }) => {
  const results = new Array(jobs.length);
  let next = 0;
  const run = async () => {
    while (next < jobs.length) {
      const i = next++;
      const { path, mtimeMs, size } = jobs[i];
      results[i] = await parseTrack(path, { mtimeMs, size });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, run));
  parentPort.postMessage({ id, results });
});
