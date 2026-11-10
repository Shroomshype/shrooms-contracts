/* Testnet stand-ins. Every pool stakes SHROOMS or the SHROOMS-HYPE LP, so these
   are the only two tokens the farm needs — no blue chips, no outside assets.

   On mainnet neither of these is deployed by us: SHROOMS comes from the Montra
   launch and the LP token is the Uniswap v4 position for the SHROOMS/HYPE pair.
   Pass their real addresses via SHROOMS_ADDRESS / SHROOMS_LP_ADDRESS and skip
   this script entirely.

   Refuses to run on a chain id that is not a known testnet: `mint` is open to
   anyone, which on a live chain is a free money printer.                       */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const TOKENS = [
  { key: "SHROOMS",    name: "Test Shrooms",         symbol: "tSHROOMS", decimals: 18, drip: 25000 },
  { key: "SHROOMS_LP", name: "Test SHROOMS-HYPE LP", symbol: "tSH-LP",   decimals: 18, drip: 500 },
];

const TESTNET_CHAIN_IDS = new Set([31337, 1337, 99801]);

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (!TESTNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `Refusing to deploy open-mint test tokens to chain ${chainId}. ` +
      `These are testnet-only. On mainnet pass SHROOMS_ADDRESS and SHROOMS_LP_ADDRESS instead.`
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log(`deploying stand-ins as ${deployer.address} on ${network.name} (chain ${chainId})\n`);

  const Token = await ethers.getContractFactory("TestToken");
  const addresses = {};
  const addrs = [];
  const amounts = [];

  for (const t of TOKENS) {
    const c = await Token.deploy(t.name, t.symbol, t.decimals);
    await c.waitForDeployment();
    const a = await c.getAddress();
    addresses[t.key] = { address: a, symbol: t.symbol, decimals: t.decimals };
    addrs.push(a);
    amounts.push(ethers.parseUnits(String(t.drip), t.decimals));
    console.log(`  ${t.symbol.padEnd(9)} ${a}  (drips ${t.drip.toLocaleString()})`);
  }

  const faucet = await (await ethers.getContractFactory("Faucet")).deploy(addrs, amounts);
  await faucet.waitForDeployment();
  const faucetAddr = await faucet.getAddress();
  console.log(`\n  Faucet    ${faucetAddr}  (1h cooldown per address)`);

  const out = { chainId, network: network.name, faucet: faucetAddr, tokens: addresses };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, "..", "deployments", `${network.name}.mocks.json`),
    JSON.stringify(out, null, 2)
  );

  console.log(`\nwrote deployments/${network.name}.mocks.json`);
  console.log(`Call faucet.drip() from any wallet to get test SHROOMS and LP.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
