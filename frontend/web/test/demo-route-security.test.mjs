import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {describe, test, before, after} from 'node:test';
import {fileURLToPath} from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abiDir = path.resolve(webRoot, 'abi');
const mockPath = path.resolve(webRoot, 'test/helpers/arbiscan-fetch-mock.mjs');
const repoRoot = path.resolve(webRoot, '../..');

const VALID_ADDRESS = '0x0000000000000000000000000000000000000001';
const XSS_BREAKOUT = '</script><script>alert(1)</script>';
const READ_SENTINEL = 'SENTINEL_SECRET_VALUE_9f3a';

let rpc;

function encodeSegment(decoded) {
  return [...decoded].map((ch) => {
    if (ch === '.') return '%2e';
    if (ch === '/') return '%2f';
    return encodeURIComponent(ch);
  }).join('');
}

function outsideTarget(name) {
  const target = path.join('/tmp/spog-demo-traversal', name);
  const relativeFile = path.relative(abiDir, target);
  assert.equal(path.isAbsolute(relativeFile) || relativeFile.startsWith('..'), true);
  const decoded = relativeFile.slice(0, -'.json'.length);
  const resolved = path.resolve(webRoot, `./abi/${decoded}.json`);
  assert.equal(resolved, target);
  assert.equal(resolved.startsWith(abiDir + path.sep), false);
  return {target, decoded};
}

function manifest() {
  return {
    'public/custom/css/base.css': {file: 'base.css'},
    'public/custom/css/web3modal.css': {file: 'web3modal.css'},
    'public/custom/js/wallet.js': {file: 'wallet.js'},
  };
}

function abiDocument() {
  return [{
    type: 'event',
    name: 'VotesTallied',
    inputs: [
      {name: 'uninformedClaimable', type: 'int256', internalType: 'int256'},
      {name: 'informedClaimable', type: 'int256', internalType: 'int256'},
      {name: 'abstainedClaimable', type: 'int256', internalType: 'int256'},
      {name: XSS_BREAKOUT, type: 'string', internalType: 'string'},
      {name: READ_SENTINEL, type: 'string', internalType: 'string'},
    ],
  }];
}

function startRpc() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          payload = {};
        }
        // web3-core Web3RequestManager.send returns response.result when
        // the body is a JSON-RPC result object, and rejects when response.id
        // is present and differs from the request id.
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : null,
          result: [],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      resolve({server, url: `http://127.0.0.1:${port}`});
    });
  });
}

function startApp() {
  const child = spawn(process.execPath, ['--import', mockPath, 'app.js'], {
    cwd: webRoot,
    env: {...process.env, WEB3_PROJECT_URL: rpc.url},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  let onEarlyExit;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`demo server did not start\n${logs}`));
    }, 20000);
    const onData = () => {
      if (logs.includes('Dev server running')) {
        clearTimeout(timer);
        child.off('exit', onEarlyExit);
        resolve();
      }
    };
    onEarlyExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`demo server exited ${code} before listening\n${logs}`));
    };
    child.stdout.on('data', onData);
    child.once('exit', onEarlyExit);
  });
  return {child, ready};
}

async function stopApp(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function request(pathname) {
  try {
    const response = await fetch(`http://127.0.0.1:3000${pathname}`, {
      signal: AbortSignal.timeout(8000),
    });
    return {status: response.status, body: await response.text()};
  } catch (error) {
    return {status: 0, body: '', error};
  }
}

function assertNotCreated(target) {
  if (!fs.existsSync(target)) {
    return;
  }
  const content = fs.readFileSync(target, 'utf8');
  fs.rmSync(target, {force: true});
  assert.fail(`GET /demo wrote ${target} before the handler finished: ${JSON.stringify(content)}`);
}

describe('unauthenticated /demo/:contractAddress filesystem and template bounds', {concurrency: 1}, () => {
  before(async () => {
    fs.mkdirSync(path.join('/tmp/spog-demo-traversal'), {recursive: true});
    fs.mkdirSync(path.join(webRoot, 'dist'), {recursive: true});
    fs.writeFileSync(path.join(webRoot, 'dist/manifest.json'), JSON.stringify(manifest()));
    rpc = await startRpc();
  });

  after(async () => {
    if (rpc) {
      await new Promise((resolve) => rpc.server.close(resolve));
    }
    fs.rmSync(path.join('/tmp/spog-demo-traversal'), {recursive: true, force: true});
    fs.rmSync(path.join(repoRoot, 'spog-finding-target.json'), {force: true});
    fs.rmSync(path.join(abiDir, `${VALID_ADDRESS}.json`), {force: true});
  });

  test('percent-encoded dot-dot-slash does not create a json file outside abi', async () => {
    const {target, decoded} = outsideTarget('created-outside.json');
    fs.rmSync(target, {force: true});
    const app = startApp();
    try {
      await app.ready;
      await request(`/demo/${encodeSegment(decoded)}`);
      assertNotCreated(target);
    } finally {
      await stopApp(app.child);
      fs.rmSync(target, {force: true});
    }
  });

  test('three encoded dot-dot-slash segments do not create a json file outside abi', async () => {
    const decoded = '../../../spog-finding-target';
    const target = path.resolve(webRoot, `./abi/${decoded}.json`);
    assert.equal(target, path.join(repoRoot, 'spog-finding-target.json'));
    assert.equal(target.startsWith(abiDir + path.sep), false);
    fs.rmSync(target, {force: true});
    const app = startApp();
    try {
      await app.ready;
      await request(`/demo/${encodeSegment(decoded)}`);
      assertNotCreated(target);
    } finally {
      await stopApp(app.child);
      fs.rmSync(target, {force: true});
    }
  });

  test('an existing json file outside abi is not returned in the demo response', async () => {
    const cases = [
      outsideTarget('plain-secret.json'),
      outsideTarget('abi-shaped-secret.json'),
    ];
    fs.writeFileSync(cases[0].target, JSON.stringify({secret: READ_SENTINEL}));
    fs.writeFileSync(cases[1].target, JSON.stringify(abiDocument()));
    try {
      for (const item of cases) {
        const app = startApp();
        try {
          await app.ready;
          const response = await request(`/demo/${encodeSegment(item.decoded)}`);
          assert.equal(response.body.includes(READ_SENTINEL), false);
          assert.equal(response.body.includes(XSS_BREAKOUT), false);
        } finally {
          await stopApp(app.child);
        }
      }
      assert.equal(fs.readFileSync(cases[0].target, 'utf8').includes(READ_SENTINEL), true);
      assert.equal(fs.readFileSync(cases[1].target, 'utf8').includes(READ_SENTINEL), true);
    } finally {
      fs.rmSync(cases[0].target, {force: true});
      fs.rmSync(cases[1].target, {force: true});
    }
  });

  test('ABI JSON rendered into the demo script element cannot close that element', async () => {
    const abiPath = path.join(abiDir, `${VALID_ADDRESS}.json`);
    fs.mkdirSync(abiDir, {recursive: true});
    fs.writeFileSync(abiPath, JSON.stringify(abiDocument()));
    const app = startApp();
    try {
      await app.ready;
      const response = await request(`/demo/${VALID_ADDRESS}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.includes('const abi'), true);
      assert.equal(
        response.body.includes(XSS_BREAKOUT),
        false,
        'ABI text was inserted without HTML escaping inside the demo script element',
      );
    } finally {
      await stopApp(app.child);
      fs.rmSync(abiPath, {force: true});
    }
  });
});
