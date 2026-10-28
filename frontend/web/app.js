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

const ABI_DIR = path.resolve('abi');
const CONTRACT_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function abiFilePath(contractAddress) {
  const filePath = path.resolve(ABI_DIR, `${contractAddress}.json`);
  if (path.dirname(filePath) !== ABI_DIR) {
    throw new Error(`ABI path escapes ${ABI_DIR}`);
  }
  return filePath;
}

// The result is emitted inside a <script> element, so characters that could end
// the element or start an HTML construct are written as JS unicode escapes.
function serializeForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function fetchAbi(contractAddress) {
  const abiUrl = `https://api-sepolia.arbiscan.io/api?module=contract&action=getabi&address=${encodeURIComponent(contractAddress)}`;
  const response = await fetch(abiUrl);
  const abi = JSON.parse(JSON.parse(await response.text()).result);
  if (!Array.isArray(abi)) {
    throw new Error('ABI response is not an array');
  }
  return abi;
}

app.get('/demo/:contractAddress', async (req, res) => {
  const contractAddress = req.params.contractAddress;
  if (!CONTRACT_ADDRESS_PATTERN.test(contractAddress)) {
    res.status(400).send('Invalid contract address');
    return;
  }

  const filePath = abiFilePath(contractAddress);
  let abi;
  try {
    abi = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    try {
      abi = await fetchAbi(contractAddress);
    } catch (fetchError) {
      res.status(502).send('Unable to load contract ABI');
      return;
    }
    fs.writeFileSync(filePath, JSON.stringify(abi), 'utf8');
  }
  const events = abi.filter(i => i.type === 'event' | i.type === 'function');
  const web3 = new Web3(process.env.WEB3_PROJECT_URL);

  const topicsMapping = {};
  events.forEach(event => {
      const signature = `${event.name}(${event.inputs.map(j => j.internalType).join(',')})`;
      topicsMapping[web3.utils.keccak256(signature)] = signature;
  });
  const slicedTopicsMapping = Object.fromEntries(Object.entries(topicsMapping).map(([key, value]) => [key.slice(0, 10), value]));

  const contract = new web3.eth.Contract(abi, contractAddress);
  const logs = await web3.eth.getPastLogs({
    address: contractAddress,
    fromBlock: 0,
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

    if (topics.includes('VotesTallied(int256,int256,int256)')) {
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
    'contractAddress': contractAddress,
    'contract': contracts[contractAddress],
    'abiJson': serializeForScript(abi),
    'ended': ended,
    'votes': votes,
    'votesTallied': votesTallied,
    'voteTypeMap': voteTypeMap,
  });
});

app.get('/research', (req, res) => {
  res.render('pages/research.html', {});
});

// Start the server
app.listen(port, () => {
  console.log(`Dev server running on http://localhost:${port}`);
});
