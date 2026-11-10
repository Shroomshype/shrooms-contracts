/* Deploys the v2 protocol: the HYPE treasury, SPORES, and the fee-funded farm.
   Run deploy-mocks.js first on a testnet so the pools have tokens to stake.

   Order matters:
     1. LiquiditySpores — creates SPORES in its own constructor
     2. ShroomsFarm     — reads the SPORES address off the treasury
     3. setDistributor  — without this, drip() mints to the owner, not the farm

   Ownership stays with the deployer. Run deploy-timelock.js afterwards.        */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOLS = require("./lineup");
const REWARD_DURATION = 7 * 86400;

function loadMocks() {
  const f = path.join(__dirname, "..", "deployments", `${network.name}.mocks.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log(`deployer ${deployer.address} on ${network.name} (chain ${chainId})\n`);

  const admin = process.env.ADMIN_ADDRESS || deployer.address;

  // ------------------------------------------------------------ treasury
  const treasury = await (await ethers.getContractFactory("LiquiditySpores")).deploy(admin);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  const sporesAddr = await treasury.spores();
  console.log(`LiquiditySpores  ${treasuryAddr}`);
  console.log(`SporesToken      ${sporesAddr}  (created by the treasury)`);

  // ---------------------------------------------------------------- farm
  const farm = await (await ethers.getContractFactory("ShroomsFarm")).deploy(treasuryAddr, admin);
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();
  console.log(`ShroomsFarm      ${farmAddr}`);

  // Without this, drip() sends newly minted SPORES to the owner instead of the
  // farm, and nothing can be claimed. Easiest step to forget.
  await (await treasury.setDistributor(farmAddr)).wait();
  console.log(`                 distributor set to the farm`);

  // --------------------------------------------------------------- pools
  const mocks = loadMocks();
  const fromEnv = JSON.parse(process.env.POOL_TOKENS || "{}");

  // Only two underlying assets exist. On mainnet both come from Montra: SHROOMS
  // from the launch, the LP token from the SHROOMS/HYPE Uniswap v4 pair.
  function resolve(key) {
    return fromEnv[key]
      || process.env[key + "_ADDRESS"]
      || (mocks && mocks.tokens[key] && mocks.tokens[key].address);
  }

  const shroomsAddr = resolve("SHROOMS");
  const lpAddr = resolve("SHROOMS_LP");
  if (!shroomsAddr) throw new Error("No SHROOMS address — run deploy-mocks.js or set SHROOMS_ADDRESS");
  if (!lpAddr) throw new Error("No SHROOMS_LP address — run deploy-mocks.js or set SHROOMS_LP_ADDRESS");

  console.log(`\nSHROOMS          ${shroomsAddr}`);
  console.log(`SHROOMS-HYPE LP  ${lpAddr}\n`);

  const poolTokens = { SHROOMS: shroomsAddr, SHROOMS_LP: lpAddr };
  const totalWeight = POOLS.reduce((a, p) => a + p.weight, 0);

  for (const p of POOLS) {
    const addr = p.stake === "SHROOMS_LP" ? lpAddr : shroomsAddr;
    const gated = p.gate !== "0";
    await (await farm.add(addr, REWARD_DURATION, gated, ethers.parseEther(p.gate), true)).wait();
    const share = ((p.weight / totalWeight) * 100).toFixed(1);
    console.log(
      `pool ${p.pid}  ${p.name.padEnd(18)} ${p.stake.padEnd(11)} ${p.tier.padEnd(10)}` +
      `${share.padStart(5)}%  ${gated ? "gate " + Number(p.gate).toLocaleString() + " SPORES" : "open"}`
    );
  }

  // ---------------------------------------------------------------- save
  const out = {
    chainId,
    network: network.name,
    version: "v2",
    deployedAt: new Date().toISOString(),
    admin,
    ownerIsTimelock: false,
    contracts: {
      LiquiditySpores: treasuryAddr,
      SporesToken: sporesAddr,
      ShroomsFarm: farmAddr,
    },
    shroomsToken: shroomsAddr,
    lpToken: lpAddr,
    poolTokens,
  };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, "..", "deployments", `${network.name}.v2.json`),
    JSON.stringify(out, null, 2)
  );
  console.log(`\nwrote deployments/${network.name}.v2.json`);

  console.log(`
NEXT
  1. Send HYPE to the treasury to start the cycle:
       cast send ${treasuryAddr} --value 10ether --rpc-url <rpc> --private-key <key>
     or point Montra's SHROOMS fee route at that address.

  2. Wait one drip period (7 days), or on a testnet fast-forward, then:
       npx hardhat run scripts/drip-and-fund.js --network ${network.name}
     which calls drip() and hands each pool its share with notifyReward().

  3. npx hardhat run scripts/deploy-timelock.js --network ${network.name}

  4. Paste the addresses into site/js/config.js so the site reads live data.
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
