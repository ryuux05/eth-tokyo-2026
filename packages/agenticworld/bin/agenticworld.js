#!/usr/bin/env node
import { install, parseArguments } from "../lib/install.js";

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Agentic World — local MCP + skill installer

  npx agenticworld install [--client codex|claude|both] [--rpc https://…]
  npx agenticworld install --rpc https://… --update-rpc

With no --client, installs for every detected Codex/Claude Code CLI.
Requires Node 22+, macOS + Apple Swift tools or Windows x64/ARM64 + TPM.
No checkout, Hardhat, web service, key creation or wallet transaction is needed.
Existing identities, keys, skills and conflicting MCP entries are never overwritten.
For private RPC URLs, set AGENTIC_WORLD_RPC_URL instead of a command-line flag.
Stop the MCP before changing its RPC. Restart your agent after installation.`);
  } else await install(options);
} catch (error) {
  console.error(`Agentic World installation stopped: ${error.message}`);
  process.exitCode = 1;
}
