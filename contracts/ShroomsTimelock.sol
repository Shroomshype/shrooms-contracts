// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title ShroomsTimelock — the delay between deciding and doing.
/// @notice Owns SporeFarm and SporeVault. Every parameter change (emission rate,
///         pool weights, fees) has to be queued publicly and then wait out the
///         delay before it can execute, which gives depositors a window to leave
///         ahead of a change they dislike.
///
///         Without this, the owner can alter emissions or fees in a single
///         transaction and nobody can react. That is the difference between a
///         protocol and a promise.
///
/// Roles, and who should hold them:
///   PROPOSER  — the team multisig. Queues operations.
///   EXECUTOR  — address(0), meaning anyone. A queued, waited-out operation
///               should not be blocked by the team going quiet.
///   CANCELLER — the team multisig, to kill a mistaken or malicious proposal.
///   ADMIN     — nobody. Granted to the timelock itself at construction, so
///               changing the roles is itself subject to the delay.
contract ShroomsTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
