/* Completes the Ownable2Step handover to the timelock.

   Run once to queue both acceptOwnership calls, wait out the delay, then run
   again to execute them. The script works out which stage it is at by reading
   the chain, so it is safe to re-run.

     npx hardhat run scripts/timelock-accept.js --network elysiumTestnet   # queue
     ... wait out the delay ...
     npx hardhat run scripts/timelock-accept.js --network elysiumTestnet   # execute

   On success it flips ownerIsTimelock to true in the deployment record.      */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const SALT = ethers.id("shrooms:accept-ownership:v1");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployments/${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.timelock) throw new Error("No timelock recorded — run deploy-timelock.js first.");

  const timelock = await ethers.getContractAt("ShroomsTimelock", d.timelock.address);
  const farm = await ethers.getContractAt("SporeFarm", d.contracts.SporeFarm);
  const vault = await ethers.getContractAt("SporeVault", d.contracts.SporeVault);

  const data = farm.interface.encodeFunctionData("acceptOwnership", []);
  const jobs = [
    { label: "farm", target: d.contracts.SporeFarm, c: farm },
    { label: "vault", target: d.contracts.SporeVault, c: vault },
  ];

  let queued = 0, executed = 0, waiting = 0;

  for (const j of jobs) {
    const owner = await j.c.owner();
    if (owner.toLowerCase() === d.timelock.address.toLowerCase()) {
      console.log(`${j.label.padEnd(6)} already owned by the timelock`);
      executed++;
      continue;
    }

    const id = await timelock.hashOperation(j.target, 0, data, ethers.ZeroHash, SALT);

    if (!(await timelock.isOperation(id))) {
      await (await timelock.schedule(j.target, 0, data, ethers.ZeroHash, SALT, d.timelock.delaySeconds)).wait();
      console.log(`${j.label.padEnd(6)} queued — ready in ${d.timelock.delaySeconds}s`);
      queued++;
    } else if (await timelock.isOperationReady(id)) {
      await (await timelock.execute(j.target, 0, data, ethers.ZeroHash, SALT)).wait();
      console.log(`${j.label.padEnd(6)} executed — ownership accepted`);
      executed++;
    } else if (await timelock.isOperationDone(id)) {
      console.log(`${j.label.padEnd(6)} operation already done`);
      executed++;
    } else {
      const ts = await timelock.getTimestamp(id);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      console.log(`${j.label.padEnd(6)} queued, ${Number(ts) - now}s remaining`);
      waiting++;
    }
  }

  if (executed === jobs.length) {
    d.ownerIsTimelock = true;
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`\nHandover complete. Both contracts are owned by the timelock.`);
    console.log(`deployments/${network.name}.json updated: ownerIsTimelock = true`);
  } else {
    console.log(`\n${queued} queued, ${waiting} still waiting. Re-run after the delay.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
