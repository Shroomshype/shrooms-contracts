require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the solc package from node_modules instead of fetching a native binary.
// Only needed in sandboxes without access to the solc CDN — harmless elsewhere,
// and safe to delete if your machine can download compilers normally.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: "0.8.24",
    };
  }
  return runSuper();
});

const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Arbitrum Orbit chains charge for L1 data, so smaller bytecode is cheaper
      // to deploy even though Elysium's own gas is negligible.
    },
  },

  networks: {
    hardhat: {},

    // ---- Elysium (Kinetiq) · Arbitrum Orbit, settles to HyperEVM ----
    // Gas is HYPE, not ETH. Verify both values against the official docs
    // before a real deploy: https://elysium.kinetiq.xyz/docs/connecting-to-elysium
    elysiumTestnet: {
      url: process.env.ELYSIUM_TESTNET_RPC || "https://testnet-rpc.elysium.kinetiq.xyz",
      chainId: 99801,
      accounts: PK,
    },
    elysium: {
      url: process.env.ELYSIUM_RPC || "https://rpc.elysium.kinetiq.xyz",
      chainId: 99901,
      accounts: PK,
    },

    // Local fork of Elysium: real chain state, no real money, no faucet needed.
    //   npx hardhat node --fork https://rpc.elysium.kinetiq.xyz
    localFork: {
      url: "http://127.0.0.1:8545",
    },
  },

  // Elysium's explorer is Blockscout, not Etherscan.
  etherscan: {
    apiKey: {
      elysiumTestnet: "blockscout-needs-no-key",
      elysium: "blockscout-needs-no-key",
    },
    customChains: [
      {
        network: "elysiumTestnet",
        chainId: 99801,
        urls: {
          apiURL: "https://elysium.kinetiq.xyz/testnet-explorer/api",
          browserURL: "https://elysium.kinetiq.xyz/testnet-explorer",
        },
      },
      {
        network: "elysium",
        chainId: 99901,
        urls: {
          apiURL: "https://elysium.kinetiq.xyz/explorer/api",
          browserURL: "https://elysium.kinetiq.xyz/explorer",
        },
      },
    ],
  },

  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  mocha: { timeout: 120000 },
};
