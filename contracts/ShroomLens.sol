// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFarmView {
    function poolLength() external view returns (uint256);
    function totalAllocPoint() external view returns (uint256);
    function emissionPerSecond() external view returns (uint256);
    function pools(uint256 pid)
        external
        view
        returns (
            IERC20 token,
            uint64 allocPoint,
            uint64 lastRewardTime,
            uint16 depositFeeBps,
            uint256 accRewardPerShare,
            uint256 totalStaked
        );
    function users(uint256 pid, address account) external view returns (uint256 amount, uint256 rewardDebt);
    function pendingSpore(uint256 pid, address account) external view returns (uint256);
}

/// @title ShroomLens — one call, every farm card on the page.
/// @notice Returns reward emission *in SPORE per year per staked token*, scaled 1e18. It does not
///         return an APY percentage, because that requires the SPORE price and the staked token's
///         price, and putting a price oracle behind a marketing number is how you get a display
///         that lies. The frontend multiplies by prices it fetches itself. See web/lib/apy.ts.
contract ShroomLens {
    uint256 private constant YEAR = 365 days;

    struct FarmView {
        uint256 pid;
        address token;
        uint256 allocPoint;
        uint256 depositFeeBps;
        uint256 totalStaked;
        /// @dev SPORE emitted per year per 1e18 of staked token, scaled 1e18.
        uint256 rewardPerTokenPerYear;
        uint256 userStaked;
        uint256 userPending;
        uint256 userWalletBalance;
        uint256 userAllowance;
    }

    IFarmView public immutable farm;

    constructor(IFarmView _farm) {
        farm = _farm;
    }

    function farms(address account) external view returns (FarmView[] memory out) {
        uint256 len = farm.poolLength();
        uint256 totalAlloc = farm.totalAllocPoint();
        uint256 emission = farm.emissionPerSecond();

        out = new FarmView[](len);
        for (uint256 i; i < len; ++i) {
            out[i] = _one(i, account, totalAlloc, emission);
        }
    }

    function _one(uint256 pid, address account, uint256 totalAlloc, uint256 emission)
        private
        view
        returns (FarmView memory v)
    {
        (IERC20 token, uint64 allocPoint,, uint16 depositFeeBps,, uint256 totalStaked) = farm.pools(pid);

        v.pid = pid;
        v.token = address(token);
        v.allocPoint = allocPoint;
        v.depositFeeBps = depositFeeBps;
        v.totalStaked = totalStaked;

        if (totalAlloc > 0 && totalStaked > 0) {
            uint256 yearly = (emission * YEAR * allocPoint) / totalAlloc;
            v.rewardPerTokenPerYear = (yearly * 1e18) / totalStaked;
        }

        if (account != address(0)) {
            (v.userStaked,) = farm.users(pid, account);
            v.userPending = farm.pendingSpore(pid, account);
            v.userWalletBalance = token.balanceOf(account);
            v.userAllowance = token.allowance(account, address(farm));
        }
    }
}
