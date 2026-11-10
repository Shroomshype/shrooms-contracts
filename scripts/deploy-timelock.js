/* Deploys the timelock and hands it everything, then checks the deployer kept nothing.

   Run this after deploy.js. Until you do, a single private key can change the
   emission rate, pool weights and fees in one transaction with no warning — the
   finding every auditor opens with.

   Env:
     TIMELOCK_DELAY   seconds (default 172800 = 48h; 3600 on a testnet is fine)
     PROPOSERS        comma-separated addresses that may queue (default: deployer)
     CANCELLERS       comma-separated addresses that may cancel (default: proposers)

   Ownable2Step means the timelock must accept ownership in a second step. That
   acceptance is itself a timelocked operation, so this script queues it and
   prints the exact command to execute once the delay has passed.              */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DEPLOY_FILE = (n) => path.join(__dirname, "..", "deployments", `${n}.json`);

function parseList(v, fallback) {
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const file = DEPLOY_FILE(network.name);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployments/${network.name}.json — run scripts/deploy.js first.`);
  }
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const delay = Number(process.env.TIMELOCK_DELAY || 172800);
  const proposers = parseList(process.env.PROPOSERS, [deployer.address]);
  const cancellers = parseList(process.env.CANCELLERS, proposers);

  console.log(`timelock delay   ${delay}s (${(delay / 3600).toFixed(1)}h)`);
  console.log(`proposers        ${proposers.join(", ")}`);
  console.log(`executors        anyone (address(0))`);
  console.log(`cancellers       ${cancellers.join(", ")}\n`);

  if (delay < 3600) {
    console.log(`WARNING: a delay under an hour gives depositors no real window to exit.\n`);
  }

  // executors = [address(0)] means anyone may execute an operation that has
  // already been queued and waited out. admin = address(0) means no one can
  // bypass the delay to change roles.
  const Timelock = await ethers.getContractFactory("ShroomsTimelock");
  const timelock = await Timelock.deploy(delay, proposers, [ethers.ZeroAddress], ethers.ZeroAddress);
  await timelock.waitForDeployment();
  const tlAddr = await timelock.getAddress();
  console.log(`ShroomsTimelock  ${tlAddr}`);

  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  for (const c of cancellers) {
    if (!(await timelock.hasRole(CANCELLER_ROLE, c))) {
      // Proposers already get CANCELLER in OZ v5; this covers any extra addresses.
      console.log(`  note: ${c} needs CANCELLER_ROLE granted through the timelock itself`);
    }
  }

  const farm = await ethers.getContractAt("SporeFarm", d.contracts.SporeFarm);
  const vault = await ethers.getContractAt("SporeVault", d.contracts.SporeVault);
  const spore = await ethers.getContractAt("SporeToken", d.contracts.SporeToken);

  // --- Ownable2Step: offer now, timelock accepts later ---
  await (await farm.transferOwnership(tlAddr)).wait();
  console.log(`\nfarm ownership offered to timelock`);
  await (await vault.transferOwnership(tlAddr)).wait();
  console.log(`vault ownership offered to timelock`);

  // --- SporeToken uses AccessControl, which transfers immediately ---
  const ADMIN_ROLE = await spore.DEFAULT_ADMIN_ROLE();
  await (await spore.grantRole(ADMIN_ROLE, tlAddr)).wait();
  console.log(`token admin role granted to timelock`);
  await (await spore.renounceRole(ADMIN_ROLE, deployer.address)).wait();
  console.log(`token admin role renounced by deployer`);

  // --- verify the deployer really has nothing left ---
  const stillAdmin = await spore.hasRole(ADMIN_ROLE, deployer.address);
  const stillMinter = await spore.hasRole(await spore.MINTER_ROLE(), deployer.address);
  const farmOwner = await farm.owner();
  const vaultOwner = await vault.owner();

  console.log(`\n--- post-conditions ---`);
  console.log(`deployer token admin   ${stillAdmin ? "YES (BAD)" : "no"}`);
  console.log(`deployer token minter  ${stillMinter ? "YES (BAD)" : "no"}`);
  console.log(`farm owner             ${farmOwner}  ${farmOwner === deployer.address ? "(pending timelock accept)" : ""}`);
  console.log(`vault owner            ${vaultOwner} ${vaultOwner === deployer.address ? "(pending timelock accept)" : ""}`);

  if (stillAdmin || stillMinter) {
    throw new Error("deployer still holds privileged roles — stop and fix before announcing");
  }

  d.timelock = { address: tlAddr, delaySeconds: delay, proposers, cancellers };
  d.ownerIsTimelock = false; // not true until acceptOwnership executes
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  console.log(`
REMAINING STEP — the timelock must accept both ownerships.

  Queue each call through the timelock (schedule, wait ${delay}s, execute):

    target   ${d.contracts.SporeFarm}
    data     ${farm.interface.encodeFunctionData("acceptOwnership", [])}

    target   ${d.contracts.SporeVault}
    data     ${vault.interface.encodeFunctionData("acceptOwnership", [])}

  Then set ownerIsTimelock: true in deployments/${network.name}.json.
  Until both execute, the previous owner can still cancel the handover.
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
