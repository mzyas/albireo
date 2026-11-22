import { parentPort, workerData } from "node:worker_threads";
import { type SearchOptions, searchFiles } from "./search.js";

// Entry point of the thread started by `runSearch`; not part of the public API.
const port = parentPort;
if (!port) throw new Error("search-worker must run as a worker thread");

searchFiles(workerData as SearchOptions).then(
  (result) => port.postMessage({ result }),
  (err: unknown) => port.postMessage({ error: err instanceof Error ? err.message : String(err) }),
);
