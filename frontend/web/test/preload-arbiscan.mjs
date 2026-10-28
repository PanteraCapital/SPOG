/**
 * Test preload. app.js calls global fetch for the Arbiscan ABI URL.
 * web3's HTTP provider uses its own client (cross-fetch / node-fetch) and is
 * pointed at the local JSON-RPC server instead, so this replacement does not
 * intercept eth_getLogs or eth_getTransactionByHash.
 */
import fs from 'fs';

const abiJson = fs.readFileSync(process.env.DEMO_ABI_FIXTURE, 'utf8');
const logPath = process.env.ABI_FETCH_LOG;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://api-sepolia.arbiscan.io/')) {
    fs.appendFileSync(logPath, `${url}\n`);
    const body = JSON.stringify({status: '1', message: 'OK', result: abiJson});
    return new Response(body, {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }
  return realFetch(input, init);
};
