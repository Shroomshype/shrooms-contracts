// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title SPORES — the reward and game token.
/// @notice Deliberately dumb. It has no cap, no owner and no pause. All of the
///         interesting rules live in LiquiditySpores, which is the only address
///         that can mint, and which holds the HYPE that backs every token.
///
///         Supply is therefore bounded by HYPE actually received, not by a
///         schedule anyone can change. There is no emission curve to argue about
///         because there are no emissions — only distribution of fees collected.
contract SporesToken is ERC20, ERC20Permit {
    /// @dev Set once at construction and never again. There is no setter, so the
    ///      mint authority cannot be moved or added to after deployment.
    address public immutable treasury;

    error OnlyTreasury();

    constructor(address treasury_) ERC20("Spores", "SPORES") ERC20Permit("Spores") {
        require(treasury_ != address(0), "treasury=0");
        treasury = treasury_;
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert OnlyTreasury();
        _;
    }

    function mint(address to, uint256 amount) external onlyTreasury {
        _mint(to, amount);
    }

    /// @notice Burn on behalf of a holder, used by the treasury for redemptions
    ///         and by the farm for boost purchases. Both routes already require
    ///         the holder's own transaction, so no allowance dance is needed.
    function burnFrom(address from, uint256 amount) external onlyTreasury {
        _burn(from, amount);
    }
}
