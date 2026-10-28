import { parentPort, workerData } from 'node:worker_threads'
import { KnowledgeIndex } from './unified-index.js'

// Index segmentation is CPU work; keep it away from the bot's event loop.
parentPort.postMessage(new KnowledgeIndex(workerData))
