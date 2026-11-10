// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title SPORE — the reward token farmed by every Shrooms strain.
/// @notice Supply is hard-capped in code. Nothing, including the admin, can mint past MAX_SUPPLY.
///         Only addresses holding MINTER_ROLE (in practice: SporeFarm) can mint at all.
contract SporeToken is ERC20, ERC20Burnable, ERC20Permit, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @dev Fixed forever. There is no setter.
    uint256 public constant MAX_SUPPLY = 21_000_000e18;

    error CapExceeded(uint256 requested, uint256 remaining);

    constructor(address admin) ERC20("Spore", "SPORE") ERC20Permit("Spore") {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function mintable() public view returns (uint256) {
        return MAX_SUPPLY - totalSupply();
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        uint256 room = mintable();
        if (amount > room) revert CapExceeded(amount, room);
        _mint(to, amount);
    }
}
