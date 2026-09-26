import { network } from "hardhat";

const { viem, networkName } = await network.create();
if (networkName !== "localhost") throw new Error("Deploy this demo only to the configured localhost network");
const client = await viem.getPublicClient();
const chainId = await client.getChainId();
if (chainId !== 31337) throw new Error(`Expected local chain 31337, got ${chainId}`);
const entryPoint = await viem.deployContract("RealEntryPoint");
const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
const implementation = await factory.read.implementation();
const deploymentBlock = await client.getBlock();
process.stdout.write(`LOCAL_DEPLOYMENT ${JSON.stringify({ chainId, entryPoint: entryPoint.address,
  factory: factory.address, implementation, deploymentBlockNumber: deploymentBlock.number.toString(),
  deploymentBlockHash: deploymentBlock.hash })}\n`);
process.stdout.write(`Copy into portal/config.ts under ${chainId}:\n  ${chainId}: { factory: "${factory.address}", implementation: "${implementation}" },\n`);
