/* The weekly cycle: pull one period's SPORES out of the treasury, then hand each
   pool its share to stream.

   drip() is permissionless, so in production this should be a cron job or a
   Chainlink upkeep rather than a person. notifyReward is owner-only, so once the
   timelock owns the farm this half has to be queued through it — see DEPLOY.md.

   Weights decide how the pot is split. They are the only place pool "rarity"
   turns into something mechanical.                                             */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const WEIGHTS = require("./lineup").map((p) => p.weight);

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.v2.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployments/${network.name}.v2.json — run deploy-v2.js first`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const treasury = await ethers.getContractAt("LiquiditySpores", d.contracts.LiquiditySpores);
  const spores = await ethers.getContractAt("SporesToken", d.contracts.SporesToken);
  const farm = await ethers.getContractAt("ShroomsFarm", d.contracts.ShroomsFarm);

  // ------------------------------------------------------------- 1. drip
  const ready = await treasury.dripReadyAt();
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  if (now < Number(ready)) {
    const mins = Math.ceil((Number(ready) - now) / 60);
    console.log(`drip not ready for another ${mins} minutes (${new Date(Number(ready) * 1000).toISOString()})`);
    console.log(`On a local chain: npx hardhat run scripts/fast-forward.js --network localFork`);
    return;
  }

  const [hypePreview, sporesPreview] = await treasury.previewDrip();
  console.log(`dripping ${ethers.formatEther(hypePreview)} HYPE -> ${ethers.formatEther(sporesPreview)} SPORES`);
  await (await treasury.drip()).wait();

  const floor = await treasury.backingPerSpore();
  console.log(`backing per SPORES is now ${ethers.formatEther(floor)} HYPE`);

  // ------------------------------------------------- 2. split across pools
  const held = await spores.balanceOf(d.contracts.ShroomsFarm);
  const poolCount = Number(await farm.poolLength());
  console.log(`\nfarm holds ${ethers.formatEther(held)} SPORES across ${poolCount} pools`);

  // Only distribute the newly dripped amount; whatever is already streaming
  // stays streaming. notifyReward folds leftovers in on its own.
  const toSplit = sporesPreview;
  const totalWeight = WEIGHTS.slice(0, poolCount).reduce((a, b) => a + b, 0);

  for (let pid = 0; pid < poolCount; pid++) {
    const share = (toSplit * BigInt(WEIGHTS[pid])) / BigInt(totalWeight);
    if (share === 0n) continue;
    await (await farm.notifyReward(pid, share)).wait();
    console.log(`  pool ${pid}  ${ethers.formatEther(share)} SPORES over 7 days`);
  }

  console.log(`\nDone. Rewards are streaming; stakers accrue from the next block.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
