// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface ISporeFarm {
    function deposit(uint256 pid, uint256 amount) external;
    function withdraw(uint256 pid, uint256 amount) external;
    function emergencyWithdraw(uint256 pid) external;
    function pendingSpore(uint256 pid, address account) external view returns (uint256);
    function users(uint256 pid, address account) external view returns (uint256 amount, uint256 rewardDebt);
}

/// @title SporeVault — "it compounds itself".
/// @notice Users hold shares, not a balance. Every harvest re-stakes rewards into the farm, so a
///         share is worth strictly more SPORE afterwards. Nobody has to claim anything.
///
///         harvest() is permissionless and pays the caller a bounty. That is what actually makes
///         the compounding happen on schedule — a bot, a Chainlink Automation upkeep, or any user
///         who wants the bounty calls it. There is no privileged keeper.
contract SporeVault is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 shares;
        uint256 lastDepositedAt;
    }

    IERC20 public immutable spore;
    ISporeFarm public immutable farm;
    uint256 public immutable pid;

    mapping(address => UserInfo) public userInfo;
    uint256 public totalShares;
    uint256 public lastHarvestedAt;

    /// @dev Permanently locked on first deposit. Never withdrawable by anyone.
    uint256 public constant MINIMUM_SHARES = 1e6;

    address public treasury;

    // fees, all capped in code
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 500; // 5% of harvested yield
    uint256 public constant MAX_CALL_FEE_BPS = 100;        // 1% of harvested yield
    uint256 public constant MAX_WITHDRAW_FEE_BPS = 50;     // 0.5%, early exits only
    uint256 public constant MAX_WITHDRAW_FEE_PERIOD = 3 days;

    uint256 public performanceFeeBps = 200;
    uint256 public callFeeBps = 25;
    uint256 public withdrawFeeBps = 10;
    uint256 public withdrawFeePeriod = 4 hours;

    event Deposited(address indexed user, uint256 amount, uint256 shares);
    event Withdrawn(address indexed user, uint256 amount, uint256 shares);
    event Harvested(address indexed caller, uint256 compounded, uint256 callBounty, uint256 perfFee);
    event FeesSet(uint256 performanceFeeBps, uint256 callFeeBps, uint256 withdrawFeeBps, uint256 period);
    event EmergencyExited(uint256 recovered);

    error FeeTooHigh();
    error NothingToDeposit();
    error BadShares();

    constructor(IERC20 _spore, ISporeFarm _farm, uint256 _pid, address _treasury, address _owner) Ownable(_owner) {
        require(_treasury != address(0), "treasury=0");
        spore = _spore;
        farm = _farm;
        pid = _pid;
        treasury = _treasury;
        lastHarvestedAt = block.timestamp;
        _spore.forceApprove(address(_farm), type(uint256).max);
    }

    // ------------------------------------------------------------ views

    /// @notice SPORE sitting idle in this contract (not yet staked).
    function available() public view returns (uint256) {
        return spore.balanceOf(address(this));
    }

    /// @notice Total SPORE the vault controls: idle + staked in the farm.
    function totalAssets() public view returns (uint256) {
        (uint256 staked,) = farm.users(pid, address(this));
        return available() + staked;
    }

    /// @notice SPORE per share, scaled 1e18. Monotonically increasing except for fees.
    function pricePerShare() external view returns (uint256) {
        return totalShares == 0 ? 1e18 : (totalAssets() * 1e18) / totalShares;
    }

    function balanceOf(address account) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (userInfo[account].shares * totalAssets()) / totalShares;
    }

    /// @notice What harvest() would pay its caller right now. Bots poll this.
    function callBounty() external view returns (uint256) {
        return (farm.pendingSpore(pid, address(this)) * callFeeBps) / 10_000;
    }

    // --------------------------------------------------------- user flow

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert NothingToDeposit();

        uint256 poolBefore = totalAssets();
        uint256 before = spore.balanceOf(address(this));
        spore.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = spore.balanceOf(address(this)) - before;

        uint256 shares;
        if (totalShares == 0 || poolBefore == 0) {
            // Burn MINIMUM_SHARES to nobody on the first deposit. Without this, a first depositor
            // can take 1 wei of shares, donate a large balance to move pricePerShare, and round
            // every later depositor's shares down toward zero.
            require(received > MINIMUM_SHARES, "first deposit too small");
            shares = received - MINIMUM_SHARES;
            totalShares += MINIMUM_SHARES;
        } else {
            shares = (received * totalShares) / poolBefore;
        }
        if (shares == 0) revert BadShares();

        UserInfo storage u = userInfo[msg.sender];
        u.shares += shares;
        u.lastDepositedAt = block.timestamp;
        totalShares += shares;

        _earn();
        emit Deposited(msg.sender, received, shares);
    }

    function withdraw(uint256 shares) public nonReentrant {
        UserInfo storage u = userInfo[msg.sender];
        if (shares == 0 || shares > u.shares) revert BadShares();

        uint256 amount = (totalAssets() * shares) / totalShares;
        u.shares -= shares;
        totalShares -= shares;

        uint256 idle = available();
        if (idle < amount) {
            farm.withdraw(pid, amount - idle);
            // farm.withdraw also pays pending rewards to us; only send what was asked
            uint256 bal = available();
            if (bal < amount) amount = bal;
        }

        if (block.timestamp < u.lastDepositedAt + withdrawFeePeriod && withdrawFeeBps > 0) {
            uint256 fee = (amount * withdrawFeeBps) / 10_000;
            amount -= fee;
            spore.safeTransfer(treasury, fee);
        }

        spore.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shares);
    }

    function withdrawAll() external {
        withdraw(userInfo[msg.sender].shares);
    }

    // ---------------------------------------------------------- compounding

    /// @notice Permissionless. Harvests farm rewards, pays fees, re-stakes the rest.
    function harvest() external nonReentrant whenNotPaused {
        farm.deposit(pid, 0); // pulls pending SPORE to this contract

        uint256 harvested = available();
        if (harvested == 0) {
            lastHarvestedAt = block.timestamp;
            return;
        }

        uint256 bounty = (harvested * callFeeBps) / 10_000;
        uint256 perf = (harvested * performanceFeeBps) / 10_000;

        if (bounty > 0) spore.safeTransfer(msg.sender, bounty);
        if (perf > 0) spore.safeTransfer(treasury, perf);

        lastHarvestedAt = block.timestamp;
        _earn();

        emit Harvested(msg.sender, harvested - bounty - perf, bounty, perf);
    }

    function _earn() internal {
        uint256 bal = available();
        if (bal > 0) farm.deposit(pid, bal);
    }

    // --------------------------------------------------------------- admin

    function setFees(uint256 _perf, uint256 _call, uint256 _withdraw, uint256 _period) external onlyOwner {
        if (
            _perf > MAX_PERFORMANCE_FEE_BPS || _call > MAX_CALL_FEE_BPS || _withdraw > MAX_WITHDRAW_FEE_BPS
                || _period > MAX_WITHDRAW_FEE_PERIOD
        ) revert FeeTooHigh();

        performanceFeeBps = _perf;
        callFeeBps = _call;
        withdrawFeeBps = _withdraw;
        withdrawFeePeriod = _period;
        emit FeesSet(_perf, _call, _withdraw, _period);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "treasury=0");
        treasury = _treasury;
    }

    /// @notice Pauses deposits and harvests. Withdrawals stay open, always.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Pull everything out of the farm into the vault so users can exit if the farm breaks.
    function emergencyExitFarm() external onlyOwner {
        farm.emergencyWithdraw(pid);
        _pause();
        emit EmergencyExited(available());
    }
}
