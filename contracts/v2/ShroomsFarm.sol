// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {LiquiditySpores} from "./LiquiditySpores.sol";
import {SporesToken} from "./SporesToken.sol";

/// @title ShroomsFarm — fee-funded staking with a game layer on top.
///
/// WHY NOT MASTERCHEF
/// ------------------
///   MasterChef assumes it can mint rewards on demand at a fixed rate per second.
///   Rewards here are funded by SHROOMS trading fees, which arrive in lumps and
///   in unpredictable sizes. So this uses Synthetix StakingRewards accounting:
///   a pot is handed over with notifyReward() and streams out over a fixed
///   window. The contract can never promise rewards it does not already hold.
///
/// WHY BOOSTS ARE SAFE HERE
/// ------------------------
///   A multiplier changes a staker's share of a FIXED pot. It cannot create new
///   SPORES. Under an emissions model, buying a boost that raises your emission
///   rate is a reflexive loop — spend to earn, earn to spend. Under fee funding
///   it is strictly zero-sum between stakers, so the game layer cannot inflate
///   the token no matter how it is tuned.
///
/// THE THREE SINKS
/// ---------------
///   lock()      SPORES locked for a term, returned at the end. Temporary sink,
///               removes sell pressure for the duration.
///   levelUp()   SPORES burned for a permanent per-pool multiplier. Real sink.
///   unlockPool()SPORES burned once to gain access to a gated strain. Real sink.
///
///   Both burns leave their HYPE in the treasury, which lifts the redemption
///   floor for every remaining holder.
contract ShroomsFarm is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;

    // --- boost ceilings, fixed in code so no owner can tune them into a rug ---
    uint256 public constant MAX_TOTAL_MULTIPLIER = 3 * WAD;  // 3.00x hard ceiling
    uint256 public constant FERTILISER_BONUS = WAD / 2;      // +0.50x on fertilised stake
    uint256 public constant MIN_REWARD_DURATION = 1 hours;
    uint256 public constant MAX_REWARD_DURATION = 30 days;

    /// @notice SPORES burned to fertilise one whole staking token, scaled WAD.
    ///         Cost therefore scales with how much you stake, which is the point:
    ///         a flat level ladder is a finite sink that every committed player
    ///         exhausts in a few months, after which burn demand — and with it
    ///         the rising floor — stops. Charging per unit of stake ties burn
    ///         volume to TVL, so the sink grows as the platform does.
    uint256 public constant FERTILISER_COST_PER_TOKEN = WAD / 10; // 0.1 SPORES per token

    struct Pool {
        IERC20 token;
        uint64 rewardDuration;
        uint64 periodFinish;
        uint64 lastUpdateTime;
        uint256 rewardRate;            // SPORES per second, scaled WAD
        uint256 rewardPerTokenStored;  // per unit of EFFECTIVE stake
        uint256 totalStaked;
        uint256 totalEffective;
        uint256 unlockCost;            // SPORES burned once to access; 0 = open
        bool gated;
    }

    struct UserPool {
        uint256 balance;
        uint256 effective;
        uint256 rewardPerTokenPaid;
        uint256 rewards;
        /// @notice How much of this position has been fertilised. Stake above
        ///         this earns at the unfertilised rate until more is bought.
        uint256 fertilised;
        bool unlocked;
    }

    /// @notice One lock per user, boosting every pool they are in. Simpler to
    ///         reason about than per-pool locks and far cheaper to checkpoint.
    struct Lock {
        uint256 amount;
        uint64 end;
        uint64 term;    // seconds, determines the tier
    }

    LiquiditySpores public immutable treasury;
    SporesToken public immutable spores;

    Pool[] public pools;
    mapping(uint256 => mapping(address => UserPool)) public users;
    mapping(address => Lock) public locks;
    /// @notice How many pools stake a given token. Several strains deliberately
    ///         share SHROOMS, which is safe here because each pool tracks its own
    ///         totalStaked and never derives accounting from balanceOf — the
    ///         hazard the v1 duplicate ban existed to prevent. Adding a shared
    ///         pool still has to be stated explicitly, so it cannot happen by
    ///         accident while wiring pools by hand.
    mapping(address => uint256) public poolsForToken;

    /// @notice May call notifyReward and nothing else. This exists because
    ///         notifyReward is an OPERATIONAL action, not a governance one: it
    ///         starts a reward period using SPORES the farm already holds, and
    ///         changes no parameter. Folding it into onlyOwner meant a routine
    ///         weekly chore inherited the timelock's delay, which is the wrong
    ///         granularity. The owner can always call it too, and can revoke
    ///         this address at any time.
    ///
    ///         It cannot be permissionless: repeatedly calling notifyReward
    ///         folds the unpaid remainder into a fresh full duration, so anyone
    ///         could stretch the payout rate toward zero for free. Hence a named
    ///         address, rate-limited below.
    address public rewardDistributor;

    /// @notice Last notifyReward per pool, used to rate-limit the distributor.
    mapping(uint256 => uint64) public lastNotified;

    /// @notice SPORES held on behalf of lockers. Reserved: it is other people's
    ///         principal sitting in this contract, and must never be promised as
    ///         rewards. Without this, notifyReward would see locked SPORES in
    ///         balanceOf and happily commit it — the same failure that
    ///         SporeFarm.sporePid guards against in v1.
    uint256 public totalLocked;

    /// @notice Lock term -> multiplier bonus above 1x, scaled WAD.
    ///         7d:+0.10  30d:+0.25  90d:+0.60  180d:+1.00
    uint64[4] public LOCK_TERMS = [uint64(7 days), 30 days, 90 days, 180 days];
    uint256[4] public LOCK_BONUS = [WAD / 10, WAD / 4, (WAD * 6) / 10, WAD];

    event PoolAdded(uint256 indexed pid, address indexed token, bool gated, uint256 unlockCost);
    event RewardNotified(uint256 indexed pid, uint256 amount, uint256 duration);
    event RewardDistributorSet(address indexed distributor);
    event Staked(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdrawn(address indexed user, uint256 indexed pid, uint256 amount);
    event Claimed(address indexed user, uint256 indexed pid, uint256 amount);
    event Locked(address indexed user, uint256 amount, uint64 term, uint64 end);
    event Unlocked(address indexed user, uint256 amount);
    event Fertilised(address indexed user, uint256 indexed pid, uint256 amount, uint256 burned, uint256 total);
    event PoolUnlocked(address indexed user, uint256 indexed pid, uint256 burned);
    event Kicked(address indexed user, uint256 indexed pid, address by);
    event EmergencyWithdrawn(address indexed user, uint256 indexed pid, uint256 amount);

    error BadPool();
    error DuplicatePool();
    error ZeroAmount();
    error InsufficientBalance();
    error PoolIsGated();
    error AlreadyUnlocked();
    error AlreadyFertilised();
    error BadTerm();
    error LockNotExpired();
    error NoLock();
    error LockStillActive();
    error BadDuration();
    error RewardTooHigh();
    error NotAuthorisedToNotify();
    error NotifyTooSoon(uint256 readyAt);
    error NothingToKick();

    constructor(LiquiditySpores treasury_, address owner_) Ownable(owner_) {
        treasury = treasury_;
        spores = treasury_.spores();
    }

    function poolLength() external view returns (uint256) {
        return pools.length;
    }

    // ===================================================== reward accounting

    function lastTimeRewardApplicable(uint256 pid) public view returns (uint256) {
        uint256 finish = pools[pid].periodFinish;
        return block.timestamp < finish ? block.timestamp : finish;
    }

    function rewardPerToken(uint256 pid) public view returns (uint256) {
        Pool storage p = pools[pid];
        if (p.totalEffective == 0) return p.rewardPerTokenStored;
        uint256 elapsed = lastTimeRewardApplicable(pid) - p.lastUpdateTime;
        return p.rewardPerTokenStored + (elapsed * p.rewardRate * WAD) / p.totalEffective;
    }

    function earned(uint256 pid, address account) public view returns (uint256) {
        UserPool storage u = users[pid][account];
        return u.rewards + (u.effective * (rewardPerToken(pid) - u.rewardPerTokenPaid)) / WAD;
    }

    /// @dev Settle `account` before any change to their effective balance, so a
    ///      multiplier change never applies retroactively to time already earned.
    modifier updateReward(uint256 pid, address account) {
        Pool storage p = pools[pid];
        p.rewardPerTokenStored = rewardPerToken(pid);
        p.lastUpdateTime = uint64(lastTimeRewardApplicable(pid));
        if (account != address(0)) {
            UserPool storage u = users[pid][account];
            u.rewards = earned(pid, account);
            u.rewardPerTokenPaid = p.rewardPerTokenStored;
        }
        _;
    }

    // ============================================================== multiplier

    /// @notice Current lock bonus for `user`, 0 if the lock has expired.
    function lockBonus(address user) public view returns (uint256) {
        Lock storage l = locks[user];
        if (l.amount == 0 || block.timestamp >= l.end) return 0;
        for (uint256 i; i < 4; ++i) {
            if (l.term == LOCK_TERMS[i]) return LOCK_BONUS[i];
        }
        return 0;
    }

    /// @notice Multiplier applied to the FERTILISED portion of a position.
    ///         Unfertilised stake always earns at 1.00x plus any lock bonus.
    function multiplierOf(uint256, address user) public view returns (uint256) {
        uint256 m = WAD + lockBonus(user) + FERTILISER_BONUS;
        return m > MAX_TOTAL_MULTIPLIER ? MAX_TOTAL_MULTIPLIER : m;
    }

    /// @notice The blended multiplier actually earned across a whole position,
    ///         scaled WAD. This is the number worth showing a player.
    function effectiveMultiplierOf(uint256 pid, address user) external view returns (uint256) {
        UserPool storage u = users[pid][user];
        if (u.balance == 0) return WAD + lockBonus(user);
        return (_effectiveFor(pid, user) * WAD) / u.balance;
    }

    /// @dev Fertilised stake earns the boosted rate, the remainder earns the
    ///      base rate. Buying capacity rather than a flat percentage is what
    ///      makes the sink scale with position size.
    function _effectiveFor(uint256 pid, address user) internal view returns (uint256) {
        UserPool storage u = users[pid][user];
        uint256 base = WAD + lockBonus(user);
        if (base > MAX_TOTAL_MULTIPLIER) base = MAX_TOTAL_MULTIPLIER;

        uint256 boostedPart = u.fertilised < u.balance ? u.fertilised : u.balance;
        uint256 plainPart = u.balance - boostedPart;

        return (boostedPart * multiplierOf(pid, user) + plainPart * base) / WAD;
    }

    /// @dev Recompute one user's effective stake and the pool total. Must run
    ///      inside updateReward or rewards will be misattributed.
    function _syncEffective(uint256 pid, address user) private {
        Pool storage p = pools[pid];
        UserPool storage u = users[pid][user];
        uint256 next = _effectiveFor(pid, user);
        p.totalEffective = p.totalEffective - u.effective + next;
        u.effective = next;
    }

    /// @notice Re-checkpoint a user whose lock has expired, dropping their boost.
    ///         Permissionless: nobody will downgrade themselves, so anyone else
    ///         staked in the pool may do it, and doing so increases their own
    ///         share. Same pattern as Curve's gauge kick.
    function kick(uint256 pid, address user) external updateReward(pid, user) {
        UserPool storage u = users[pid][user];
        // Compare against the same blended figure _syncEffective would store,
        // otherwise a position with no stale boost still looks kickable.
        if (_effectiveFor(pid, user) == u.effective) revert NothingToKick();
        _syncEffective(pid, user);
        emit Kicked(user, pid, msg.sender);
    }

    // ================================================================ staking

    function stake(uint256 pid, uint256 amount)
        external nonReentrant whenNotPaused updateReward(pid, msg.sender)
    {
        if (pid >= pools.length) revert BadPool();
        if (amount == 0) revert ZeroAmount();
        Pool storage p = pools[pid];
        UserPool storage u = users[pid][msg.sender];
        if (p.gated && !u.unlocked) revert PoolIsGated();

        // measure the delta so a fee-on-transfer token cannot desync accounting
        uint256 before = p.token.balanceOf(address(this));
        p.token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = p.token.balanceOf(address(this)) - before;

        u.balance += received;
        p.totalStaked += received;
        _syncEffective(pid, msg.sender);

        emit Staked(msg.sender, pid, received);
    }

    function withdraw(uint256 pid, uint256 amount)
        public nonReentrant updateReward(pid, msg.sender)
    {
        if (pid >= pools.length) revert BadPool();
        if (amount == 0) revert ZeroAmount();
        Pool storage p = pools[pid];
        UserPool storage u = users[pid][msg.sender];
        if (u.balance < amount) revert InsufficientBalance();

        u.balance -= amount;
        p.totalStaked -= amount;
        _syncEffective(pid, msg.sender);

        p.token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, pid, amount);
    }

    function claim(uint256 pid) public nonReentrant updateReward(pid, msg.sender) {
        UserPool storage u = users[pid][msg.sender];
        uint256 r = u.rewards;
        if (r == 0) return;
        u.rewards = 0;
        // Rewards were transferred in by notifyReward, so this contract already
        // holds them. Nothing is minted here.
        IERC20(address(spores)).safeTransfer(msg.sender, r);
        emit Claimed(msg.sender, pid, r);
    }

    function exit(uint256 pid) external {
        withdraw(pid, users[pid][msg.sender].balance);
        claim(pid);
    }

    /// @notice Principal out, rewards abandoned. Never pausable.
    function emergencyWithdraw(uint256 pid) external nonReentrant {
        if (pid >= pools.length) revert BadPool();
        Pool storage p = pools[pid];
        UserPool storage u = users[pid][msg.sender];

        uint256 amount = u.balance;
        p.totalEffective -= u.effective;
        p.totalStaked -= amount;
        u.balance = 0;
        u.effective = 0;
        u.rewards = 0;
        u.rewardPerTokenPaid = 0;
        u.fertilised = 0; // capacity is tied to the position, which is gone

        p.token.safeTransfer(msg.sender, amount);
        emit EmergencyWithdrawn(msg.sender, pid, amount);
    }

    // ============================================================= game layer

    /// @notice Lock SPORES for a fixed term to boost every pool you stake in.
    ///         Extending or adding tops up the same lock; the term may only be
    ///         raised, never shortened.
    function lock(uint256 amount, uint64 term, uint256[] calldata pidsToSync)
        external nonReentrant whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        bool valid;
        for (uint256 i; i < 4; ++i) if (term == LOCK_TERMS[i]) valid = true;
        if (!valid) revert BadTerm();

        Lock storage l = locks[msg.sender];
        if (term < l.term && block.timestamp < l.end) revert BadTerm();

        IERC20(address(spores)).safeTransferFrom(msg.sender, address(this), amount);
        l.amount += amount;
        totalLocked += amount;
        l.term = term;
        l.end = uint64(block.timestamp) + term;

        _syncMany(pidsToSync);
        emit Locked(msg.sender, l.amount, term, l.end);
    }

    /// @notice Reclaim a lock once its term has run. SPORES comes back whole —
    ///         locking is a temporary sink, not a burn.
    function unlock(uint256[] calldata pidsToSync) external nonReentrant {
        Lock storage l = locks[msg.sender];
        if (l.amount == 0) revert NoLock();
        if (block.timestamp < l.end) revert LockStillActive();

        uint256 amount = l.amount;
        l.amount = 0;
        l.end = 0;
        l.term = 0;
        totalLocked -= amount;

        IERC20(address(spores)).safeTransfer(msg.sender, amount);
        _syncMany(pidsToSync);
        emit Unlocked(msg.sender, amount);
    }

    /// @notice Burn SPORES to fertilise more of this position. Permanent, and
    ///         it stays with you — but staking more later means the new stake
    ///         is unfertilised until you buy capacity for it too.
    /// @param amount how much additional stake to cover, in staking-token units
    function fertilise(uint256 pid, uint256 amount)
        external nonReentrant whenNotPaused updateReward(pid, msg.sender)
    {
        if (pid >= pools.length) revert BadPool();
        if (amount == 0) revert ZeroAmount();
        UserPool storage u = users[pid][msg.sender];

        // Don't let anyone pay to fertilise land they haven't got.
        uint256 room = u.balance > u.fertilised ? u.balance - u.fertilised : 0;
        if (room == 0) revert AlreadyFertilised();
        if (amount > room) amount = room;

        uint256 cost = fertiliserCost(amount);
        treasury.burnForBoost(msg.sender, cost);

        u.fertilised += amount;
        _syncEffective(pid, msg.sender);
        emit Fertilised(msg.sender, pid, amount, cost, u.fertilised);
    }

    /// @notice SPORES burned to fertilise `amount` of staking token.
    function fertiliserCost(uint256 amount) public pure returns (uint256) {
        return (amount * FERTILISER_COST_PER_TOKEN) / WAD;
    }

    /// @notice Unfertilised portion of a position — what more capacity would cover.
    function unfertilised(uint256 pid, address user) external view returns (uint256) {
        UserPool storage u = users[pid][user];
        return u.balance > u.fertilised ? u.balance - u.fertilised : 0;
    }

    /// @notice Burn SPORES once to gain access to a gated strain.
    function unlockPool(uint256 pid) external nonReentrant whenNotPaused {
        if (pid >= pools.length) revert BadPool();
        Pool storage p = pools[pid];
        UserPool storage u = users[pid][msg.sender];
        if (!p.gated) revert BadPool();
        if (u.unlocked) revert AlreadyUnlocked();

        treasury.burnForBoost(msg.sender, p.unlockCost);
        u.unlocked = true;
        emit PoolUnlocked(msg.sender, pid, p.unlockCost);
    }

    function _syncMany(uint256[] calldata pids) private {
        for (uint256 i; i < pids.length; ++i) {
            uint256 pid = pids[i];
            if (pid >= pools.length) revert BadPool();
            Pool storage p = pools[pid];
            p.rewardPerTokenStored = rewardPerToken(pid);
            p.lastUpdateTime = uint64(lastTimeRewardApplicable(pid));
            UserPool storage u = users[pid][msg.sender];
            u.rewards = earned(pid, msg.sender);
            u.rewardPerTokenPaid = p.rewardPerTokenStored;
            _syncEffective(pid, msg.sender);
        }
    }

    // ================================================================== admin

    /// @param allowSharedToken must be true to add a second pool for a token that
    ///        already has one. Several strains share SHROOMS on purpose; this flag
    ///        keeps that deliberate rather than accidental.
    function add(IERC20 token, uint64 rewardDuration, bool gated, uint256 unlockCost, bool allowSharedToken)
        external onlyOwner
    {
        if (poolsForToken[address(token)] > 0 && !allowSharedToken) revert DuplicatePool();
        if (rewardDuration < MIN_REWARD_DURATION || rewardDuration > MAX_REWARD_DURATION) revert BadDuration();
        require(address(token) != address(0), "token=0");

        poolsForToken[address(token)] += 1;
        pools.push(Pool({
            token: token,
            rewardDuration: rewardDuration,
            periodFinish: 0,
            lastUpdateTime: uint64(block.timestamp),
            rewardRate: 0,
            rewardPerTokenStored: 0,
            totalStaked: 0,
            totalEffective: 0,
            unlockCost: unlockCost,
            gated: gated
        }));
        emit PoolAdded(pools.length - 1, address(token), gated, unlockCost);
    }

    /// @notice Hand a pool a pot of SPORES to stream over its reward duration.
    ///         The SPORES must already have been transferred to this contract.
    ///         Reverts if it has not, so a pool can never promise what it does
    ///         not hold — the single most common failure in forked farms.
    function notifyReward(uint256 pid, uint256 amount)
        external updateReward(pid, address(0))
    {
        if (pid >= pools.length) revert BadPool();
        Pool storage p = pools[pid];

        if (msg.sender != owner()) {
            if (msg.sender != rewardDistributor) revert NotAuthorisedToNotify();
            // Rate-limit the distributor. Each call folds the unpaid remainder
            // into a fresh full duration, so an unbounded caller could restart
            // periods repeatedly and dilute the payout rate toward zero. Half a
            // period leaves ample room for the intended weekly cadence while
            // capping how far a compromised key could stretch it.
            uint256 readyAt = uint256(lastNotified[pid]) + (p.rewardDuration / 2);
            if (block.timestamp < readyAt) revert NotifyTooSoon(readyAt);
        }
        lastNotified[pid] = uint64(block.timestamp);

        if (block.timestamp >= p.periodFinish) {
            p.rewardRate = amount / p.rewardDuration;
        } else {
            uint256 leftover = (p.periodFinish - block.timestamp) * p.rewardRate;
            p.rewardRate = (amount + leftover) / p.rewardDuration;
        }

        // Solvency check: everything this pool has promised must be on hand,
        // counting only SPORES that is actually ours to give. Locked principal
        // belongs to the lockers and is excluded.
        uint256 bal = IERC20(address(spores)).balanceOf(address(this));
        uint256 held = bal > totalLocked ? bal - totalLocked : 0;
        if (p.rewardRate * p.rewardDuration > held) revert RewardTooHigh();

        p.lastUpdateTime = uint64(block.timestamp);
        p.periodFinish = uint64(block.timestamp + p.rewardDuration);
        emit RewardNotified(pid, amount, p.rewardDuration);
    }

    function setRewardDuration(uint256 pid, uint64 duration) external onlyOwner {
        if (pid >= pools.length) revert BadPool();
        if (duration < MIN_REWARD_DURATION || duration > MAX_REWARD_DURATION) revert BadDuration();
        Pool storage p = pools[pid];
        require(block.timestamp >= p.periodFinish, "period running");
        p.rewardDuration = duration;
    }

    /// @notice Name the address allowed to start reward periods. Set it to the
    ///         keeper so the weekly split does not need a timelock proposal.
    ///         Setting it to address(0) disables the role entirely.
    function setRewardDistributor(address d) external onlyOwner {
        rewardDistributor = d;
        emit RewardDistributorSet(d);
    }

    function setGate(uint256 pid, bool gated, uint256 unlockCost) external onlyOwner {
        if (pid >= pools.length) revert BadPool();
        pools[pid].gated = gated;
        pools[pid].unlockCost = unlockCost;
    }

    /// @notice Stops staking, locking and levelling. Withdrawals, claims and
    ///         emergency exits stay open — a pause protects users, not the team.
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
