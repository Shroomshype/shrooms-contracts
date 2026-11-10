// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken — a stand-in for WBTC / LINK / DAI / USDC on a fresh testnet.
/// @notice A new chain has none of the tokens the farm expects, so pools 1-7 would
///         have nothing to stake. These fill that gap.
///
///         NOT FOR MAINNET. `mint` is unrestricted on purpose: anyone can create
///         supply from nothing. Deploying this to a live chain would be a free
///         money printer, so the deploy script refuses to touch it off-testnet.
contract TestToken is ERC20 {
    uint8 private immutable _decimals;

    /// @dev Guards against the whole supply being conjured in one call, which makes
    ///      the "grove capacity" bars on the site meaningless during testing.
    uint256 public constant MAX_MINT_PER_CALL = 1_000_000;

    error MintTooLarge();

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _decimals = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Anyone may mint. Testnet only.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT_PER_CALL * 10 ** _decimals) revert MintTooLarge();
        _mint(to, amount);
    }
}
