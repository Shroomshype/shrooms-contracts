// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestToken} from "./TestToken.sol";

/// @title Faucet — one call hands a tester every token the farms accept.
/// @notice Saves clicking through seven separate mints before you can use the site.
///         Rate-limited per address so a single wallet cannot flood a pool and
///         make the capacity bars meaningless.
///
///         NOT FOR MAINNET. See TestToken.
contract Faucet {
    uint256 public constant COOLDOWN = 1 hours;

    TestToken[] public tokens;
    uint256[] public amounts;
    mapping(address => uint256) public lastDrip;

    event Dripped(address indexed to);

    error TooSoon(uint256 readyAt);
    error LengthMismatch();

    /// @param tokens_  the test tokens to hand out
    /// @param amounts_ how much of each, already scaled to that token's decimals
    constructor(TestToken[] memory tokens_, uint256[] memory amounts_) {
        if (tokens_.length != amounts_.length) revert LengthMismatch();
        tokens = tokens_;
        amounts = amounts_;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function readyAt(address who) external view returns (uint256) {
        uint256 last = lastDrip[who];
        return last == 0 ? 0 : last + COOLDOWN;
    }

    /// @notice Mint one helping of every test token to the caller.
    function drip() external {
        uint256 last = lastDrip[msg.sender];
        if (last != 0 && block.timestamp < last + COOLDOWN) {
            revert TooSoon(last + COOLDOWN);
        }
        lastDrip[msg.sender] = block.timestamp;

        uint256 n = tokens.length;
        for (uint256 i; i < n; ++i) {
            tokens[i].mint(msg.sender, amounts[i]);
        }
        emit Dripped(msg.sender);
    }
}
