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
const contractsList = yaml.load(fs.readFileSync('./../../voting-rounds.yml', 'utf8'));
const contracts = contractsList.reduce((contracts, contract) => Object.assign({}, contracts, {[contract.address]: contract}), {});
env.addGlobal('contracts', contracts);
env.addGlobal('contractsList', contractsList);

app.get('/', (req, res) => {
  res.render('pages/spog.html', {});
});

app.get('/demo/:contractAddress', async (req, res) => {
  const abiString = fs.readFileSync(`./abi/${req.params.contractAddress}.json`, 'utf8');
  const abi = JSON.parse(abiString);
  const events = abi.filter(i => i.type === 'event');
  const web3 = new Web3(process.env.WEB3_PROJECT_URL);

  const topicsMapping = {};
  events.forEach(event => {
      const signature = `${event.name}(${event.inputs.map(j => j.internalType).join(',')})`;
      topicsMapping[web3.utils.keccak256(signature)] = signature;
  });

  const contract = new web3.eth.Contract(abi, req.params.contractAddress);
  const logs = await web3.eth.getPastLogs({
    address: req.params.contractAddress,
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
  logs.forEach(log => {
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
      votesTallied.push(web3.eth.abi.decodeLog(votesTalliedAbi.inputs, log.data));
    }
  });

  console.log(votesTallied, votes);
  res.render('pages/demo.html', {
    'contractAddress': req.params.contractAddress,
    'contract': contracts[req.params.contractAddress],
    'abi': abiString,
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
