// Stand-in for the hardcoded Arbiscan request in app.js.
// The handler does: fetch(url) -> response.text() -> JSON.parse(...).result -> writeFileSync.
// This returns the JSON object shape observed from
// GET https://api-sepolia.arbiscan.io/api?module=contract&action=getabi&address=0x0000000000000000000000000000000000000000
// and the same shape for address=notanaddress (both status 0, string result).
// Web3's HTTP provider imports cross-fetch, so this global fetch replacement
// does not intercept eth_getLogs.

const ARBISCAN_BODY = JSON.stringify({
  status: '0',
  message: 'NOTOK',
  result:
    'You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration',
});

globalThis.fetch = async (url) => {
  const href = String(url);
  if (!href.startsWith('https://api-sepolia.arbiscan.io/api?')) {
    throw new Error(`unexpected global fetch: ${href}`);
  }
  return new Response(ARBISCAN_BODY, {
    status: 200,
    headers: {'content-type': 'application/json'},
  });
};
