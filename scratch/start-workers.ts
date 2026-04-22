import { startBackgroundWorkers } from '../src/services/background/manager.js';
import { config } from '../src/config.js';

console.error('Starting background workers in standalone mode...');
console.error('Concurrency limit:', config.backgroundWorker.maxConcurrency);
startBackgroundWorkers();
