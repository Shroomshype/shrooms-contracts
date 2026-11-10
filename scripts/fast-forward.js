/* Local/testnet convenience: jump the chain forward so drip() becomes callable
   without waiting a real week. Only works on a node that supports evm_increaseTime
   (hardhat node, anvil). Refuses on a live chain. */
const { ethers, network } = require("hardhat");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (![31337, 1337].includes(chainId)) {
    throw new Error(`Chain ${chainId} is not a local node — you cannot fast-forward a real chain. Wait out the drip period.`);
  }
  const secs = Number(process.env.SECONDS || 7 * 86400);
  await ethers.provider.send("evm_increaseTime", [secs]);
  await ethers.provider.send("evm_mine");
  const b = await ethers.provider.getBlock("latest");
  console.log(`advanced ${secs}s — chain time is now ${new Date(b.timestamp * 1000).toISOString()}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
