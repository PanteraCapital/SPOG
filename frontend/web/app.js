import path from 'path';
import fs from 'fs';
import nunjucks from 'nunjucks';
import express from 'express';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import Web3 from 'web3';

const app = express();
const port = 3000;

dotenv.config({path: './.env'});
app.use(express.static('public/libs'));
app.use('/dist', express.static('dist'))
app.use('/assets', express.static('dist/assets'))

nunjucks.configure('views', {autoescape: true, express: app});
const env = nunjucks.configure('views', {autoescape: true, express: app});
env.addGlobal('manifest', JSON.parse(fs.readFileSync('dist/manifest.json', 'utf-8')));
const contractsList = yaml.load(fs.readFileSync('./../../contracts.yml', 'utf8'));
const contracts = contractsList.reduce((contracts, contract) => Object.assign({}, contracts, {[contract.address]: contract}), {});
env.addGlobal('contracts', contracts);
env.addGlobal('contractsList', contractsList);
function formattedDate() {
  return new Intl.DateTimeFormat('en-US', {weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true}).format(new Date());
}
env.addGlobal('formattedDate', formattedDate());

app.get('/', (req, res) => {
  res.render('pages/spog.html', {});
});

const DEMO_MAX_BLOCK_WINDOW = 50_000n;
const DEMO_MAX_TALLY_LOOKUPS = 100;
const DEMO_MAX_SCANS = 5;
const DEMO_RATE_WINDOW_MS = 10_000;
const ABI_DIR = './abi';

const roundsByAddress = new Map(contractsList.map((contract) => [String(contract.address).toLowerCase(), contract]));

const demoScanTimes = [];
function takeDemoScanSlot() {
  const now = Date.now();
  while (demoScanTimes.length > 0 && now - demoScanTimes[0] >= DEMO_RATE_WINDOW_MS) {
    demoScanTimes.shift();
  }
  if (demoScanTimes.length >= DEMO_MAX_SCANS) {
    return false;
  }
  demoScanTimes.push(now);
  return true;
}

function parseAbi(abiString) {
  const abi = JSON.parse(abiString);
  if (!Array.isArray(abi)) {
    throw new Error('ABI is not an array');
  }
  return abi;
}

async function loadRoundAbi(address) {
  const filePath = path.join(ABI_DIR, `${address}.json`);
  try {
    const abiString = fs.readFileSync(filePath, 'utf8');
    return {abiString, abi: parseAbi(abiString)};
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  const abiUrl = `https://api-sepolia.arbiscan.io/api?module=contract&action=getabi&address=${address}`;
  const response = await fetch(abiUrl);
  const abiString = JSON.parse(await response.text()).result;
  const abi = parseAbi(abiString);
  fs.mkdirSync(ABI_DIR, {recursive: true});
  fs.writeFileSync(filePath, abiString, 'utf8');
  return {abiString, abi};
}

app.get('/demo/:contractAddress', async (req, res) => {
  const round = roundsByAddress.get(String(req.params.contractAddress).toLowerCase());
  if (!round) {
    res.status(404).send('Unknown round');
    return;
  }
  if (!takeDemoScanSlot()) {
    res.set('Retry-After', String(Math.ceil(DEMO_RATE_WINDOW_MS / 1000)));
    res.status(429).send('Too many requests');
    return;
  }
  try {
    await renderDemo(res, round);
  } catch (e) {
    console.error(`Demo for ${round.address} failed:`, e);
    if (!res.headersSent) {
      res.status(502).send('Unable to load round');
    }
  }
});

async function renderDemo(res, round) {
  const address = round.address;
  const {abiString, abi} = await loadRoundAbi(address);
  const events = abi.filter(i => i.type === 'event' | i.type === 'function');
  const web3 = new Web3(process.env.WEB3_PROJECT_URL);

  const topicsMapping = {};
  events.forEach(event => {
      const signature = `${event.name}(${event.inputs.map(j => j.internalType).join(',')})`;
      topicsMapping[web3.utils.keccak256(signature)] = signature;
  });
  const slicedTopicsMapping = Object.fromEntries(Object.entries(topicsMapping).map(([key, value]) => [key.slice(0, 10), value]));

  const latestBlock = BigInt(await web3.eth.getBlockNumber());
  const fromBlock = latestBlock > DEMO_MAX_BLOCK_WINDOW ? latestBlock - DEMO_MAX_BLOCK_WINDOW : 0n;
  const logs = await web3.eth.getPastLogs({
    address,
    fromBlock,
    toBlock: latestBlock,
    topics: [null],
  });

  const voteAbi = abi.find((item) => item.name === 'VoteSubmitted');
  const votesTalliedAbi = abi.find((item) => item.name === 'VotesTallied');
  const voteTypeMap = {'informedClaimable': 3, 'uninformedClaimable': 2, 'abstainedClaimable': 1}
  const swappedVoteTypeMap = Object.fromEntries(
    Object.entries(voteTypeMap).map(([key, value]) => [value, key])
  );
  let ended = false;
  let votes = {};
  let votesTallied = [];

  for (const log of logs) {
    const topics = log.topics.map(t => topicsMapping[t] || t);

    if (topics.includes('RoundEnded(bool)')) {
      ended = true;
    }

    if (topics.includes('VoteSubmitted(int256,int256)')) {
      const decodedData = web3.eth.abi.decodeLog(voteAbi.inputs, log.data);
      const key = swappedVoteTypeMap[decodedData['0']]
      if (!votes[key]) {
        votes[key] = 0;
      }

      votes[key] += 1;
    }

    if (topics.includes('VotesTallied(int256,int256,int256)') && votesTallied.length < DEMO_MAX_TALLY_LOOKUPS) {
      let transaction = await web3.eth.getTransaction(log.transactionHash);
      votesTallied.push({...web3.eth.abi.decodeLog(votesTalliedAbi.inputs, log.data), 'type': slicedTopicsMapping[transaction.input]});
    }
  }

  let funcParams = votesTalliedAbi.inputs.map((param) => param.name);
  votesTallied = votesTallied.map((votes) => {
    funcParams.forEach((param) => {
      votes[param] = Number(votes[param]) / (10 ** 18);
    });
    return votes
  })

  res.render('pages/demo.html', {
    'contractAddress': address,
    'contract': round,
    'abi': abiString,
    'ended': ended,
    'votes': votes,
    'votesTallied': votesTallied,
    'voteTypeMap': voteTypeMap,
  });
}

app.get('/research', (req, res) => {
  res.render('pages/research.html', {});
});

// Start the server
app.listen(port, () => {
  console.log(`Dev server running on http://localhost:${port}`);
});
