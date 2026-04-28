import { spawn } from 'node:child_process';

const child = spawn('bun', ['run', 'src/index.ts'], {
  env: { ...process.env, GNOSIS_ENABLE_AUTOMATION: 'true', GNOSIS_NO_WORKERS: 'true' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

child.stdout.on('data', (data) => {
  console.log('STDOUT:', data.toString());
});

// Keep it alive
setTimeout(() => {
  console.log('Test finished after 5s');
  child.kill();
  process.exit(0);
}, 5000);
