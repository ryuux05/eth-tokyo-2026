// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";

/// @dev Compiles the official ERC-4337 EntryPoint for local integration tests.
contract RealEntryPoint is EntryPoint {}
