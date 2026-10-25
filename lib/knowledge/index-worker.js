import { parentPort, workerData } from 'node:worker_threads'
import { LoreIndex } from './search.js'

// Index segmentation is CPU work; keep it away from the bot's event loop.
parentPort.postMessage(new LoreIndex(workerData))
