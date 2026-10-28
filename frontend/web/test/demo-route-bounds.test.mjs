/**
 * Spec for GET /demo/:contractAddress in frontend/web/app.js.
 *
 * These tests fail while the handler is open: any path segment can download
 * an ABI into abi/<segment>.json, eth_getLogs runs from block 0, every
 * VotesTallied log triggers eth_getTransactionByHash, and nothing limits
 * how often that work runs.
 *
 * They pass once all of the following hold:
 * - Only addresses listed in contracts.yml are served. The cache file and the
 *   eth_getLogs address are that exact contracts.yml string. A different
 *   casing is not a second cache key and is not the address sent to the RPC.
 * - A request that is not served does not fetch an ABI and does not create
 *   or delete a file before the response.
 * - eth_getLogs fromBlock is inside the last MAX_BLOCK_WINDOW blocks
 *   (the tag "latest" counts as the tip). Block 0 and "earliest" do not.
 * - One request issues at most MAX_LOGS eth_getTransactionByHash calls.
 * - A fresh process serves at most MAX_SCANS demo scans per
 *   RATE_WINDOW_MS, including when the requests arrive together. Scans past
 *   that return 429 and do not call eth_getLogs.
 *
 * Run from the repository root:
 *   node --test frontend/web/test/demo-route-bounds.test.mjs
 *
 * gulpfile.js download-abi is not covered. It is a build task that loops
 * contracts.yml and is not reached by an HTTP request.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'fs';
import http from 'node:http';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import Web3 from 'web3';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');
const ABI_DIR = path.join(WEB_ROOT, 'abi');
const FIXTURE_PATH = path.join(WEB_ROOT, 'test/fixtures/demo-abi.json');
const PRELOAD_PATH = path.join(WEB_ROOT, 'test/preload-arbiscan.mjs');
const FETCH_LOG = path.join(WEB_ROOT, 'test/.abi-fetch.log');
const MANIFEST_PATH = path.join(WEB_ROOT, 'dist/manifest.json');

const LATEST_BLOCK = 2_000_000;
const MAX_BLOCK_WINDOW = 50_000;
const MAX_LOGS = 100;
const TALLY_LOGS_RETURNED = 250;
const MAX_SCANS = 5;
const RATE_WINDOW_MS = 10_000;
const TALLY_SIGNATURE = 'VotesTallied(int256,int256,int256)';

const contractsList = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'contracts.yml'), 'utf8'));
const roundOne = contractsList[0];
const roundTwo = contractsList[1];

const web3 = new Web3();
const tallyTopic = web3.utils.keccak256(TALLY_SIGNATURE);
const tallyData = web3.eth.abi.encodeParameters(
  ['int256', 'int256', 'int256'],
  [10n ** 18n, 2n * 10n ** 18n, 3n * 10n ** 18n],
);

const rpcState = {
  mode: 'empty',
  calls: [],
};

let rpcServer;
let rpcUrl;
let appProc;
const createdDuringRun = new Set();

function listAbiFiles() {
  if (!fs.existsSync(ABI_DIR)) return [];
  return fs.readdirSync(ABI_DIR).sort();
}

function rememberAbiTree() {
  for (const name of listAbiFiles()) createdDuringRun.add(name);
}

function resetFetchLog() {
  fs.writeFileSync(FETCH_LOG, '');
}

function fetchLogLines() {
  if (!fs.existsSync(FETCH_LOG)) return [];
  return fs.readFileSync(FETCH_LOG, 'utf8').split('\n').filter(Boolean);
}

function blockNumber(value) {
  if (value === 'latest' || value === 'pending' || value === 'safe' || value === 'finalized') {
    return LATEST_BLOCK;
  }
  if (value === 'earliest') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.startsWith('0x')) return Number(BigInt(value));
  if (typeof value === 'string' && value !== '') return Number(value);
  return null;
}

function logResult(address, index) {
  const hash = `0x${index.toString(16).padStart(64, '0')}`;
  return {
    address,
    topics: [tallyTopic],
    data: tallyData,
    blockNumber: '0x10',
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: `0x${'ab'.repeat(32)}`,
    logIndex: '0x0',
    removed: false,
  };
}

function transactionResult(hash) {
  return {
    blockHash: `0x${'11'.repeat(32)}`,
    blockNumber: '0x10',
    hash,
    transactionIndex: '0x0',
    from: '0x0000000000000000000000000000000000000001',
    to: roundOne.address,
    value: '0x0',
    gas: '0x5208',
    gasPrice: '0x1',
    input: '0x12345678',
    nonce: '0x0',
    v: '0x1b',
    r: `0x${'22'.repeat(32)}`,
    s: `0x${'33'.repeat(32)}`,
    type: '0x0',
  };
}

function startRpc() {
  return new Promise((resolve) => {
    rpcServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        const method = payload.method;
        const params = payload.params || [];
        rpcState.calls.push({method, params});
        let result = null;
        if (method === 'eth_chainId') result = '0x66eee';
        else if (method === 'eth_blockNumber') result = `0x${LATEST_BLOCK.toString(16)}`;
        else if (method === 'net_version') result = '421614';
        else if (method === 'web3_clientVersion') result = 'demo-route-bounds-test';
        else if (method === 'eth_getLogs') {
          const filter = params[0] || {};
          const count = rpcState.mode === 'many-tallies' ? TALLY_LOGS_RETURNED : 0;
          const address = typeof filter.address === 'string' ? filter.address : roundOne.address;
          result = Array.from({length: count}, (_, index) => logResult(address, index + 1));
        } else if (method === 'eth_getTransactionByHash') {
          result = transactionResult(params[0]);
        }
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({jsonrpc: '2.0', id: payload.id ?? null, result}));
      });
    });
    rpcServer.listen(0, '127.0.0.1', () => {
      const {port} = rpcServer.address();
      rpcUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopRpc() {
  return new Promise((resolve) => {
    if (!rpcServer) return resolve();
    rpcServer.close(() => resolve());
  });
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    if (appProc.exitCode !== null) {
      throw new Error(`demo server exited early with code ${appProc.exitCode}`);
    }
    try {
      const response = await fetch('http://127.0.0.1:3000/research');
      if (response.status === 200) return;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError;
}

async function startApp() {
  resetFetchLog();
  rpcState.calls = [];
  rpcState.mode = 'empty';
  const stdioLog = fs.openSync(path.join(WEB_ROOT, 'test/.demo-server.log'), 'a');
  appProc = spawn(process.execPath, [path.join(WEB_ROOT, 'app.js')], {
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      WEB3_PROJECT_URL: rpcUrl,
      DEMO_ABI_FIXTURE: FIXTURE_PATH,
      ABI_FETCH_LOG: FETCH_LOG,
      NODE_OPTIONS: `--import ${PRELOAD_PATH}`,
    },
    stdio: ['ignore', stdioLog, stdioLog],
  });
  await waitForServer();
}

function stopApp() {
  return new Promise((resolve) => {
    if (!appProc || appProc.exitCode !== null) {
      appProc = undefined;
      return resolve();
    }
    const child = appProc;
    appProc = undefined;
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000).unref();
  });
}

async function withApp(fn) {
  await startApp();
  try {
    return await fn();
  } finally {
    await stopApp();
  }
}

function callsNamed(method) {
  return rpcState.calls.filter((call) => call.method === method);
}

async function getDemo(address, {timeoutMs = 10_000} = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:3000/demo/${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return {status: response.status, body};
  } catch (error) {
    return {status: 0, body: error instanceof Error ? error.message : String(error)};
  }
}

function filesTouching(address) {
  const needle = `${address.toLowerCase()}.json`;
  return listAbiFiles().filter((name) => name.toLowerCase() === needle);
}

describe('demo route bounds', {concurrency: 1}, () => {
  before(async () => {
    fs.mkdirSync(ABI_DIR, {recursive: true});
    fs.mkdirSync(path.dirname(MANIFEST_PATH), {recursive: true});
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({
      'public/custom/css/base.css': {file: 'assets/base.css'},
      'public/custom/css/web3modal.css': {file: 'assets/web3modal.css'},
      'public/custom/css/spog.css': {file: 'assets/spog.css'},
      'public/custom/js/wallet.js': {file: 'assets/wallet.js'},
    }));
    rememberAbiTree();
    await startRpc();
  });

  after(async () => {
    await stopApp();
    await stopRpc();
    for (const name of listAbiFiles()) {
      if (!createdDuringRun.has(name)) {
        fs.rmSync(path.join(ABI_DIR, name), {force: true});
      }
    }
    fs.rmSync(MANIFEST_PATH, {force: true});
    fs.rmSync(FETCH_LOG, {force: true});
    fs.rmSync(path.join(WEB_ROOT, 'test/.demo-server.log'), {force: true});
  });

  test('allowlisted round keeps getPastLogs inside a recent block window', async () => {
    await withApp(async () => {
      const started = callsNamed('eth_getLogs').length;
      const response = await getDemo(roundOne.address);
      const scans = callsNamed('eth_getLogs').slice(started);
      assert.equal(response.status, 200);
      assert.match(response.body, new RegExp(roundOne.name));
      assert.ok(scans.length >= 1, 'expected the allowlisted round to scan logs');
      for (const scan of scans) {
        const filter = scan.params[0];
        assert.equal(filter.address, roundOne.address);
        const from = blockNumber(filter.fromBlock);
        assert.ok(
          from !== null && from >= LATEST_BLOCK - MAX_BLOCK_WINDOW && from <= LATEST_BLOCK,
          `fromBlock ${filter.fromBlock} is outside the last ${MAX_BLOCK_WINDOW} blocks of ${LATEST_BLOCK}`,
        );
        if (filter.toBlock !== undefined && filter.toBlock !== null) {
          const to = blockNumber(filter.toBlock);
          assert.ok(to !== null && to <= LATEST_BLOCK && to >= from);
        }
      }
    });
  });

  test('votes tallied scans are capped per request', async () => {
    await withApp(async () => {
      rpcState.mode = 'many-tallies';
      const started = callsNamed('eth_getTransactionByHash').length;
      const response = await getDemo(roundOne.address, {timeoutMs: 20_000});
      const fetched = callsNamed('eth_getTransactionByHash').length - started;
      assert.notEqual(response.status, 0, 'the capped request hung');
      assert.ok(
        fetched <= MAX_LOGS,
        `eth_getTransactionByHash ran ${fetched} times for ${TALLY_LOGS_RETURNED} VotesTallied logs; cap is ${MAX_LOGS}`,
      );
    });
  });

  test('addresses outside contracts.yml do not fetch or cache an ABI or scan logs', async () => {
    const outsiders = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      'not-a-contract',
    ];
    for (const name of outsiders.map((address) => `${address}.json`)) {
      fs.rmSync(path.join(ABI_DIR, name), {force: true});
    }
    await withApp(async () => {
      const beforeFiles = new Set(listAbiFiles());
      for (const address of outsiders) {
        const fetchesBefore = fetchLogLines().length;
        const scansBefore = callsNamed('eth_getLogs').length;
        const response = await getDemo(address);
        const added = listAbiFiles().filter((name) => !beforeFiles.has(name));
        assert.deepEqual(added, [], `${address} created cache files before refusal: ${added.join(', ')}`);
        assert.equal(
          fetchLogLines().length,
          fetchesBefore,
          `${address} downloaded an ABI before the route refused it`,
        );
        assert.equal(
          callsNamed('eth_getLogs').length,
          scansBefore,
          `${address} called eth_getLogs before the route refused it`,
        );
        assert.ok(
          response.status === 403 || response.status === 404,
          `${address} was served with status ${response.status}`,
        );
      }
    });
  });

  test('case variants cannot cache or query a different address string', async () => {
    const canonical = roundOne.address;
    const lowercase = canonical.toLowerCase();
    const brokenChecksum = `${canonical.slice(0, -1)}${canonical.endsWith('2') ? '3' : '2'}`;
    assert.notEqual(lowercase, canonical);
    assert.equal(/^(0x)?[0-9a-f]{40}$/.test(lowercase), true);
    for (const name of [`${lowercase}.json`, `${brokenChecksum}.json`, `${canonical}.json`]) {
      fs.rmSync(path.join(ABI_DIR, name), {force: true});
    }

    await withApp(async () => {
      const beforeFiles = new Set(listAbiFiles());
      const lowercaseResponse = await getDemo(lowercase);
      assert.equal(
        fs.existsSync(path.join(ABI_DIR, `${lowercase}.json`)),
        false,
        'lowercase address wrote a second ABI cache file',
      );
      const lowercaseScans = callsNamed('eth_getLogs');
      for (const scan of lowercaseScans) {
        assert.equal(scan.params[0].address, canonical);
      }
      const lowercaseFiles = filesTouching(canonical);
      for (const name of lowercaseFiles) {
        assert.equal(name, `${canonical}.json`);
      }
      if (lowercaseResponse.status === 200) {
        assert.match(lowercaseResponse.body, new RegExp(roundOne.name));
        assert.ok(lowercaseFiles.includes(`${canonical}.json`));
      } else {
        assert.ok(lowercaseResponse.status === 403 || lowercaseResponse.status === 404);
        assert.deepEqual(lowercaseFiles, []);
      }

      const filesAfterLower = new Set(listAbiFiles());
      const fetchesBefore = fetchLogLines().length;
      const scansBefore = callsNamed('eth_getLogs').length;
      const brokenResponse = await getDemo(brokenChecksum);
      const added = listAbiFiles().filter((name) => !filesAfterLower.has(name));
      assert.deepEqual(added, [], `broken checksum created cache files: ${added.join(', ')}`);
      assert.equal(fs.existsSync(path.join(ABI_DIR, `${brokenChecksum}.json`)), false);
      assert.equal(fetchLogLines().length, fetchesBefore);
      assert.equal(callsNamed('eth_getLogs').length, scansBefore);
      assert.ok(brokenResponse.status === 403 || brokenResponse.status === 404);
      for (const name of listAbiFiles()) {
        if (!beforeFiles.has(name)) {
          assert.equal(name, `${canonical}.json`);
        }
      }
    });
  });

  test('demo route rate limit holds for sequential and concurrent requests', async () => {
    assert.ok(RATE_WINDOW_MS >= 10_000);

    await withApp(async () => {
      const canonicalFile = path.join(ABI_DIR, `${roundOne.address}.json`);
      fs.writeFileSync(canonicalFile, fs.readFileSync(FIXTURE_PATH, 'utf8'));
      const beforeFiles = new Set(listAbiFiles());

      const statuses = [];
      for (let i = 0; i < MAX_SCANS + 1; i += 1) {
        const response = await getDemo(roundOne.address);
        statuses.push(response.status);
      }
      assert.ok(
        callsNamed('eth_getLogs').length <= MAX_SCANS,
        `sequential requests issued ${callsNamed('eth_getLogs').length} eth_getLogs calls; cap is ${MAX_SCANS}`,
      );
      assert.equal(statuses[statuses.length - 1], 429);
      assert.equal(fetchLogLines().length, 0);
      const added = listAbiFiles().filter((name) => !beforeFiles.has(name));
      assert.deepEqual(added, []);
    });

    await withApp(async () => {
      const canonicalFile = path.join(ABI_DIR, `${roundOne.address}.json`);
      fs.writeFileSync(canonicalFile, fs.readFileSync(FIXTURE_PATH, 'utf8'));
      const responses = await Promise.all(
        Array.from({length: MAX_SCANS * 2}, () => getDemo(roundOne.address)),
      );
      const scans = callsNamed('eth_getLogs').length;
      const rejected = responses.filter((response) => response.status === 429);
      assert.ok(
        scans <= MAX_SCANS,
        `concurrent burst issued ${scans} eth_getLogs calls; cap is ${MAX_SCANS}`,
      );
      assert.ok(
        rejected.length >= MAX_SCANS,
        `expected at least ${MAX_SCANS} responses with status 429, got ${responses.map((response) => response.status).join(',')}`,
      );
    });
  });

  test('concurrent allowlisted requests render the round that was authorized', async () => {
    await withApp(async () => {
      const [first, second] = await Promise.all([
        getDemo(roundOne.address),
        getDemo(roundTwo.address),
      ]);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.match(first.body, new RegExp(roundOne.name));
      assert.match(second.body, new RegExp(roundTwo.name));
      assert.doesNotMatch(first.body, new RegExp(`<h2>${roundTwo.name}</h2>`));
      assert.doesNotMatch(second.body, new RegExp(`<h2>${roundOne.name}</h2>`));
      const scans = callsNamed('eth_getLogs');
      assert.ok(scans.some((scan) => scan.params[0].address === roundOne.address));
      assert.ok(scans.some((scan) => scan.params[0].address === roundTwo.address));
      for (const scan of scans) {
        assert.ok(
          scan.params[0].address === roundOne.address || scan.params[0].address === roundTwo.address,
        );
      }
    });
  });
});
