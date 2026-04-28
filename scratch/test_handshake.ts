import { spawn } from 'node:child_process';

const child = spawn('bun', ['run', 'src/index.ts'], {
  env: { ...process.env, GNOSIS_ENABLE_AUTOMATION: 'true', GNOSIS_NO_WORKERS: 'true' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const sendRequest = (method: string, params: any = {}) => {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  };
  child.stdin.write(JSON.stringify(request) + '\n');
};

child.stdout.on('data', (data) => {
  const str = data.toString();
  console.log('STDOUT:', str);
  if (str.includes('protocolVersion')) {
      console.log('Successfully initialized!');
      process.exit(0);
  }
});

setTimeout(() => {
  sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });
}, 1000);

setTimeout(() => {
  console.error('Timeout');
  child.kill();
  process.exit(1);
}, 10000);
