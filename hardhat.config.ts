import { defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";

export default defineConfig({
  plugins: [hardhatViem, hardhatNodeTestRunner],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      hardfork: "prague",
    },
  },
});
