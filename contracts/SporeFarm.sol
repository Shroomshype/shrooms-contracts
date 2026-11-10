// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISporeToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function mintable() external view returns (uint256);
}

/// @title SporeFarm — the substrate. One pool per strain.
/// @notice MasterChef accounting on a per-second emission schedule.
///
/// Deliberate safety choices, because this pattern is the most-forked and most-rugged in DeFi:
///   * Emission rate is capped by MAX_EMISSION_PER_SECOND. The owner cannot turn on a firehose.
///   * Deposit fee is capped by MAX_DEPOSIT_FEE_BPS (4%). The owner cannot set a 100% fee.
///   * Each pool tracks `totalStaked` itself instead of trusting token.balanceOf(this), so pools
///     sharing a token (or receiving a stray airdrop) cannot inflate each other's rewards.
///   * `add()` rejects a token that already has a pool — the classic double-alloc footgun.
///   * emergencyWithdraw() forfeits rewards but always returns principal, and is never pausable.
///   * Ownable2Step, and the owner is expected to be a Timelock. See README.
contract SporeFarm is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant ACC_PRECISION = 1e18;
    uint256 public constant MAX_DEPOSIT_FEE_BPS = 400; // 4%
    uint256 public constant MAX_EMISSION_PER_SECOND = 1e18; // 1 SPORE/sec ceiling

    struct Pool {
        IERC20 token;
        uint64 allocPoint;
        uint64 lastRewardTime;
        uint16 depositFeeBps;
        uint256 accRewardPerShare; // scaled by ACC_PRECISION
        uint256 totalStaked;
    }

    struct User {
        uint256 amount;
        uint256 rewardDebt;
    }

    ISporeToken public immutable spore;

    Pool[] public pools;
    mapping(uint256 => mapping(address => User)) public users;
    mapping(address => bool) public tokenHasPool;

    uint256 public totalAllocPoint;
    uint256 public emissionPerSecond;
    /// @dev Pool index that stakes SPORE itself, if one exists. Its principal is reserved.
    uint256 public sporePid = type(uint256).max;
    uint256 public immutable startTime;
    address public feeCollector;

    event PoolAdded(uint256 indexed pid, address indexed token, uint64 allocPoint, uint16 depositFeeBps);
    event PoolSet(uint256 indexed pid, uint64 allocPoint, uint16 depositFeeBps);
    event EmissionSet(uint256 oldRate, uint256 newRate);
    event FeeCollectorSet(address indexed collector);
    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event Harvest(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);

    error EmissionTooHigh();
    error FeeTooHigh();
    error DuplicatePool();
    error BadPool();
    error InsufficientStake();

    constructor(ISporeToken _spore, uint256 _emissionPerSecond, uint256 _startTime, address _feeCollector, address _owner)
        Ownable(_owner)
    {
        if (_emissionPerSecond > MAX_EMISSION_PER_SECOND) revert EmissionTooHigh();
        require(_feeCollector != address(0), "collector=0");
        spore = _spore;
        emissionPerSecond = _emissionPerSecond;
        startTime = _startTime < block.timestamp ? block.timestamp : _startTime;
        feeCollector = _feeCollector;
    }

    function poolLength() external view returns (uint256) {
        return pools.length;
    }

    // --------------------------------------------------------------- admin

    function add(IERC20 token, uint64 allocPoint, uint16 depositFeeBps) external onlyOwner {
        if (depositFeeBps > MAX_DEPOSIT_FEE_BPS) revert FeeTooHigh();
        if (tokenHasPool[address(token)]) revert DuplicatePool();
        require(address(token) != address(0), "token=0");

        massUpdatePools();
        tokenHasPool[address(token)] = true;
        totalAllocPoint += allocPoint;

        uint64 last = uint64(block.timestamp > startTime ? block.timestamp : startTime);
        pools.push(Pool({
            token: token,
            allocPoint: allocPoint,
            lastRewardTime: last,
            depositFeeBps: depositFeeBps,
            accRewardPerShare: 0,
            totalStaked: 0
        }));

        if (address(token) == address(spore)) sporePid = pools.length - 1;

        emit PoolAdded(pools.length - 1, address(token), allocPoint, depositFeeBps);
    }

    function set(uint256 pid, uint64 allocPoint, uint16 depositFeeBps) external onlyOwner {
        if (pid >= pools.length) revert BadPool();
        if (depositFeeBps > MAX_DEPOSIT_FEE_BPS) revert FeeTooHigh();

        massUpdatePools();
        totalAllocPoint = totalAllocPoint - pools[pid].allocPoint + allocPoint;
        pools[pid].allocPoint = allocPoint;
        pools[pid].depositFeeBps = depositFeeBps;

        emit PoolSet(pid, allocPoint, depositFeeBps);
    }

    function setEmission(uint256 newRate) external onlyOwner {
        if (newRate > MAX_EMISSION_PER_SECOND) revert EmissionTooHigh();
        massUpdatePools();
        emit EmissionSet(emissionPerSecond, newRate);
        emissionPerSecond = newRate;
    }

    function setFeeCollector(address collector) external onlyOwner {
        require(collector != address(0), "collector=0");
        feeCollector = collector;
        emit FeeCollectorSet(collector);
    }

    // ---------------------------------------------------------- accounting

    function pendingSpore(uint256 pid, address account) external view returns (uint256) {
        if (pid >= pools.length) revert BadPool();
        Pool memory p = pools[pid];
        User memory u = users[pid][account];

        uint256 acc = p.accRewardPerShare;
        if (block.timestamp > p.lastRewardTime && p.totalStaked > 0 && totalAllocPoint > 0) {
            uint256 reward = _reward(block.timestamp - p.lastRewardTime, p.allocPoint);
            uint256 room = spore.mintable();
            if (reward > room) reward = room;
            acc += (reward * ACC_PRECISION) / p.totalStaked;
        }
        return (u.amount * acc) / ACC_PRECISION - u.rewardDebt;
    }

    function _reward(uint256 elapsed, uint256 allocPoint) private view returns (uint256) {
        if (totalAllocPoint == 0) return 0;
        return (elapsed * emissionPerSecond * allocPoint) / totalAllocPoint;
    }

    function massUpdatePools() public {
        uint256 len = pools.length;
        for (uint256 i; i < len; ++i) {
            updatePool(i);
        }
    }

    function updatePool(uint256 pid) public {
        Pool storage p = pools[pid];
        if (block.timestamp <= p.lastRewardTime) return;

        if (p.totalStaked == 0 || p.allocPoint == 0) {
            p.lastRewardTime = uint64(block.timestamp);
            return;
        }

        uint256 reward = _reward(block.timestamp - p.lastRewardTime, p.allocPoint);
        uint256 room = spore.mintable();
        if (reward > room) reward = room; // supply cap reached: emissions simply stop
        if (reward > 0) {
            spore.mint(address(this), reward);
            p.accRewardPerShare += (reward * ACC_PRECISION) / p.totalStaked;
        }
        p.lastRewardTime = uint64(block.timestamp);
    }

    // ------------------------------------------------------------- actions

    function deposit(uint256 pid, uint256 amount) external nonReentrant {
        if (pid >= pools.length) revert BadPool();
        Pool storage p = pools[pid];
        User storage u = users[pid][msg.sender];

        updatePool(pid);
        _payout(pid, u, p.accRewardPerShare);

        if (amount > 0) {
            // measure actual received, so fee-on-transfer tokens can't desync accounting
            uint256 before = p.token.balanceOf(address(this));
            p.token.safeTransferFrom(msg.sender, address(this), amount);
            uint256 received = p.token.balanceOf(address(this)) - before;

            if (p.depositFeeBps > 0) {
                uint256 fee = (received * p.depositFeeBps) / 10_000;
                received -= fee;
                p.token.safeTransfer(feeCollector, fee);
            }
            u.amount += received;
            p.totalStaked += received;
            emit Deposit(msg.sender, pid, received);
        }

        u.rewardDebt = (u.amount * p.accRewardPerShare) / ACC_PRECISION;
    }

    function withdraw(uint256 pid, uint256 amount) external nonReentrant {
        if (pid >= pools.length) revert BadPool();
        Pool storage p = pools[pid];
        User storage u = users[pid][msg.sender];
        if (u.amount < amount) revert InsufficientStake();

        updatePool(pid);
        _payout(pid, u, p.accRewardPerShare);

        if (amount > 0) {
            u.amount -= amount;
            p.totalStaked -= amount;
            p.token.safeTransfer(msg.sender, amount);
            emit Withdraw(msg.sender, pid, amount);
        }

        u.rewardDebt = (u.amount * p.accRewardPerShare) / ACC_PRECISION;
    }

    /// @notice Abandon pending rewards, get the principal out. Cannot be paused or blocked.
    function emergencyWithdraw(uint256 pid) external nonReentrant {
        if (pid >= pools.length) revert BadPool();
        Pool storage p = pools[pid];
        User storage u = users[pid][msg.sender];

        uint256 amount = u.amount;
        u.amount = 0;
        u.rewardDebt = 0;
        p.totalStaked -= amount;

        p.token.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, pid, amount);
    }

    function _payout(uint256 pid, User storage u, uint256 acc) private {
        if (u.amount == 0) return;
        uint256 pending = (u.amount * acc) / ACC_PRECISION - u.rewardDebt;
        if (pending > 0) {
            uint256 sent = _safeSporeTransfer(msg.sender, pending);
            emit Harvest(msg.sender, pid, sent);
        }
    }

    /// @dev Rounding can leave the contract a wei short; never revert a withdrawal over it.
    ///      SPORE staked in the SPORE pool is reserved and is never payable as reward — this is
    ///      the bug that lets a MasterChef fork quietly pay early harvesters with later
    ///      depositors' principal.
    function _safeSporeTransfer(address to, uint256 amount) private returns (uint256) {
        uint256 bal = spore.balanceOf(address(this));
        uint256 reserved = sporePid == type(uint256).max ? 0 : pools[sporePid].totalStaked;
        bal = bal > reserved ? bal - reserved : 0;
        uint256 send = amount > bal ? bal : amount;
        if (send > 0) IERC20(address(spore)).safeTransfer(to, send);
        return send;
    }
}
