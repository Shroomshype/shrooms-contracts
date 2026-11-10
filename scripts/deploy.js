/* Deploys the protocol: SPORE, the farm, the vault, the lens, and all eight pools.

   Order matters. Pool 0 MUST be SPORE itself — the vault farms it, and
   SporeFarm.sporePid keys off that pool to reserve staked principal.

   Token addresses for pools 2-7 come from deployments/<network>.mocks.json on a
   testnet (run deploy-mocks.js first), or from POOL_TOKENS on a real network.

   Ownership is left with the deployer here. Run deploy-timelock.js afterwards to
   hand it to a TimelockController; nothing should hold real value until you have. */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// allocPoint is emission weight, NOT an APY. The displayed percentage falls out
// of emission x weight / TVL x price — see web3/lib/apy.ts.
const POOLS = [
  { name: "Amanita Prime",     key: "SPORE",    allocPoint: 4000, depositFeeBps: 0   },
  { name: "Golden Cap",        key: "SPORE_LP", allocPoint: 2500, depositFeeBps: 0   },
  { name: "Enoki Cluster",     key: "UNI",      allocPoint: 1200, depositFeeBps: 200 },
  { name: "Blue Mycena",       key: "HYPE",     allocPoint: 1000, depositFeeBps: 200 },
  { name: "Chanterelle Grove", key: "WBTC",     allocPoint: 700,  depositFeeBps: 200 },
  { name: "Morel Deep",        key: "LINK",     allocPoint: 500,  depositFeeBps: 300 },
  { name: "Inky Cap",          key: "DAI",      allocPoint: 350,  depositFeeBps: 300 },
  { name: "Puffball Patch",    key: "USDC",     allocPoint: 250,  depositFeeBps: 300 },
];

// 0.15 SPORE/sec = ~4.73M/year against a 21M cap, so roughly a four-year schedule.
const EMISSION_PER_SECOND = ethers.parseEther("0.15");

function loadMocks() {
  const f = path.join(__dirname, "..", "deployments", `${network.name}.mocks.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  console.log(`deployer ${deployer.address} on ${network.name} (chain ${chainId})\n`);

  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;

  // ---------------------------------------------------------------- token
  const spore = await (await ethers.getContractFactory("SporeToken")).deploy(admin);
  await spore.waitForDeployment();
  const sporeAddr = await spore.getAddress();
  console.log(`SporeToken  ${sporeAddr}`);

  // ----------------------------------------------------------------- farm
  const start = (await ethers.provider.getBlock("latest")).timestamp;
  const farm = await (await ethers.getContractFactory("SporeFarm")).deploy(
    sporeAddr, EMISSION_PER_SECOND, start, treasury, admin
  );
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();
  console.log(`SporeFarm   ${farmAddr}`);

  await (await spore.grantRole(await spore.MINTER_ROLE(), farmAddr)).wait();
  console.log(`            MINTER_ROLE granted to farm`);

  // ---------------------------------------------------------------- pools
  const mocks = loadMocks();
  const fromEnv = JSON.parse(process.env.POOL_TOKENS || "{}");

  // Pool 0 is SPORE itself and must come first.
  await (await farm.add(sporeAddr, POOLS[0].allocPoint, POOLS[0].depositFeeBps)).wait();
  console.log(`\npool 0  ${POOLS[0].name.padEnd(18)} SPORE`);

  // Pool 1 is the SPORE/HYPE LP. There is no DEX pair on a bare testnet, so we
  // stand in another test token rather than leaving a hole in the lineup.
  let lpAddr = fromEnv.SPORE_LP;
  if (!lpAddr && mocks) {
    const Token = await ethers.getContractFactory("TestToken");
    const lp = await Token.deploy("Test SPORE-HYPE LP", "tSPORE-LP", 18);
    await lp.waitForDeployment();
    lpAddr = await lp.getAddress();
    console.log(`pool 1  ${POOLS[1].name.padEnd(18)} ${lpAddr}  (stand-in LP)`);
  }
  if (lpAddr) {
    await (await farm.add(lpAddr, POOLS[1].allocPoint, POOLS[1].depositFeeBps)).wait();
  } else {
    console.log(`pool 1  SKIPPED — no SPORE_LP address`);
  }

  const poolTokens = { SPORE: sporeAddr, SPORE_LP: lpAddr };
  for (let i = 2; i < POOLS.length; i++) {
    const p = POOLS[i];
    const addr = fromEnv[p.key] || (mocks && mocks.tokens[p.key] && mocks.tokens[p.key].address);
    if (!addr) {
      console.log(`pool ${i}  SKIPPED — no address for ${p.key}`);
      continue;
    }
    await (await farm.add(addr, p.allocPoint, p.depositFeeBps)).wait();
    poolTokens[p.key] = addr;
    console.log(`pool ${i}  ${p.name.padEnd(18)} ${addr}`);
  }

  // ---------------------------------------------------------------- vault
  const vault = await (await ethers.getContractFactory("SporeVault")).deploy(
    sporeAddr, farmAddr, 0, treasury, admin
  );
  await vault.waitForDeployment();
  console.log(`\nSporeVault  ${await vault.getAddress()}`);

  const lens = await (await ethers.getContractFactory("ShroomLens")).deploy(farmAddr);
  await lens.waitForDeployment();
  console.log(`ShroomLens  ${await lens.getAddress()}`);

  // ----------------------------------------------------------------- save
  const out = {
    chainId,
    network: network.name,
    deployedAt: new Date().toISOString(),
    emissionPerSecond: EMISSION_PER_SECOND.toString(),
    admin,
    treasury,
    ownerIsTimelock: false,
    contracts: {
      SporeToken: sporeAddr,
      SporeFarm: farmAddr,
      SporeVault: await vault.getAddress(),
      ShroomLens: await lens.getAddress(),
    },
    poolTokens,
  };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, "..", "deployments", `${network.name}.json`),
    JSON.stringify(out, null, 2)
  );
  console.log(`\nwrote deployments/${network.name}.json`);

  console.log(`
NEXT
  1. npx hardhat run scripts/deploy-timelock.js --network ${network.name}
     Ownership is still a single key until you do. An auditor will flag this,
     and correctly.
  2. npx hardhat verify --network ${network.name} <address> <constructor args>
     so people can read what they are depositing into.
  3. Paste the addresses into web3/lib/wagmi.ts and site/js/config.js.
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
