// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SporesToken} from "./SporesToken.sol";

/// @title LiquiditySpores — the HYPE treasury that backs SPORES.
///
/// WHAT IT IS
/// ----------
///   Montra routes the SHROOMS trading fee here in HYPE, the native gas token on
///   Elysium, so this contract simply receives value. It turns that value into
///   SPORES at a controlled rate and lets any holder redeem SPORES back for a
///   pro-rata slice of what has been committed.
///
/// TWO BUCKETS, AND WHY
/// --------------------
///   reserve   HYPE received but not yet committed. NOT redeemable.
///   backing   HYPE committed to outstanding SPORES. Always redeemable.
///
///   Trading fees are front-loaded: a launch spike, then decay. Passing them
///   straight through would mint most of the supply in the first weeks and leave
///   nothing to pay with by month two, which is how farm tokens die. Instead
///   fees land in reserve, and drip() moves a fixed slice of it across each
///   period. A spiky, decaying income becomes a long annuity — at the default
///   2% per week the reserve has a half-life of about 34 weeks, and it never
///   quite empties.
///
/// THE INVARIANT
/// -------------
///   backingPerSpore() = backing / sporesSupply   NEVER DECREASES.
///
///     drip     held flat (mint is proportional to HYPE moved across)
///     redeem   held flat (pro-rata out, supply and backing fall together)
///     burn     RISES — the HYPE stays, the claim on it leaves
///     donate   RISES — HYPE arrives with no new SPORES
///     at cap   RISES — drip can mint nothing, so HYPE becomes pure backing
///
///   The burn case is the point of the design. A player who burns SPORES to
///   fertilise a plot is handing their share of the treasury to everyone still
///   holding. Players who play make the token worth more for players who leave.
contract LiquiditySpores is Ownable2Step, ReentrancyGuard {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    /// @notice Hard ceiling on SPORES. Reaching it is not a failure state: drip
    ///         then commits HYPE with nothing minted against it, so every HYPE
    ///         after the cap is pure floor.
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    /// @notice SPORES per HYPE on the first drip, when there is no ratio to
    ///         preserve yet. Pure denomination — it sets what a "1" looks like.
    uint256 public constant BOOTSTRAP_RATE = 10_000_000;

    uint256 public constant DRIP_PERIOD = 7 days;
    uint256 public constant MIN_DRIP_BPS = 50;    // 0.5% per period
    uint256 public constant MAX_DRIP_BPS = 1000;  // 10% per period

    SporesToken public immutable spores;

    /// @notice Who receives newly minted SPORES as a reward pot. The farm.
    address public distributor;

    /// @notice HYPE received but not yet committed to any SPORES. Not redeemable.
    uint256 public reserve;

    /// @notice HYPE committed to outstanding SPORES. Always redeemable.
    uint256 public backing;

    /// @notice Share of the reserve released per period.
    uint256 public dripBps = 200; // 2%

    uint64 public lastDrip;

    uint256 public totalReceived;
    uint256 public totalRedeemed;
    uint256 public totalDripped;

    event Received(address indexed from, uint256 amount);
    event Dripped(uint256 hypeCommitted, uint256 sporesMinted, uint256 reserveLeft);
    event Redeemed(address indexed holder, uint256 sporesIn, uint256 hypeOut);
    event Donated(address indexed from, uint256 amount);
    event DistributorSet(address indexed distributor);
    event DripBpsSet(uint256 bps);
    event Swept(uint256 amount);

    error NotDistributor();
    error ZeroAmount();
    error TooSoon(uint256 readyAt);
    error NothingToDrip();
    error TransferFailed();
    error BadDripBps();
    error BackingWouldFall();

    constructor(address owner_) Ownable(owner_) {
        spores = new SporesToken(address(this));
        lastDrip = uint64(block.timestamp);
    }

    // ------------------------------------------------------------------ views

    /// @notice HYPE redeemable per whole SPORES, scaled 1e18. Monotonic upward.
    function backingPerSpore() public view returns (uint256) {
        uint256 supply = spores.totalSupply();
        if (supply == 0) return WAD / BOOTSTRAP_RATE;
        return (backing * WAD) / supply;
    }

    function previewRedeem(uint256 amount) public view returns (uint256) {
        uint256 supply = spores.totalSupply();
        if (supply == 0) return 0;
        return (amount * backing) / supply;
    }

    function dripReadyAt() public view returns (uint256) {
        return lastDrip + DRIP_PERIOD;
    }

    /// @notice What the next drip would commit and mint, at the current moment.
    function previewDrip() public view returns (uint256 hypeOut, uint256 sporesOut) {
        hypeOut = (reserve * dripBps) / BPS;
        if (hypeOut == 0) return (0, 0);
        sporesOut = _mintableFor(hypeOut);
    }

    /// @dev HYPE sitting here beyond what the two buckets account for. Only
    ///      non-zero after a forced transfer (selfdestruct, coinbase payout).
    function unaccounted() public view returns (uint256) {
        uint256 tracked = reserve + backing;
        uint256 bal = address(this).balance;
        return bal > tracked ? bal - tracked : 0;
    }

    // ------------------------------------------------------------- receiving

    /// @notice Take HYPE into the reserve. Mints nothing — drip() does that.
    function fund() public payable {
        if (msg.value == 0) revert ZeroAmount();
        reserve += msg.value;
        totalReceived += msg.value;
        emit Received(msg.sender, msg.value);
    }

    /// @dev Montra's fee route will arrive as a plain transfer.
    receive() external payable {
        fund();
    }

    /// @notice Commit HYPE straight to backing with nothing minted against it.
    ///         Raises the floor for every holder immediately. For grants,
    ///         buybacks, or revenue you do not want creating new claims.
    function donate() external payable {
        if (msg.value == 0) revert ZeroAmount();
        backing += msg.value;
        emit Donated(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ drip

    /// @dev SPORES mintable against `hypeIn` without diluting anyone.
    ///      Proportional minting keeps (backing+h)/(supply+s) == backing/supply.
    ///      Clamped by MAX_SUPPLY, so past the cap this returns less than
    ///      proportional — or zero — and the HYPE becomes pure backing.
    function _mintableFor(uint256 hypeIn) internal view returns (uint256) {
        uint256 supply = spores.totalSupply();
        uint256 minted;

        if (supply == 0 || backing == 0) {
            minted = hypeIn * BOOTSTRAP_RATE;
        } else {
            minted = (hypeIn * supply) / backing;
        }

        uint256 room = MAX_SUPPLY > supply ? MAX_SUPPLY - supply : 0;
        return minted > room ? room : minted;
    }

    /// @notice Move one period's slice of the reserve into backing and mint the
    ///         matching SPORES to the distributor. Permissionless — the farm
    ///         needs this to happen on schedule and should not depend on us.
    function drip() external nonReentrant returns (uint256 hypeOut, uint256 sporesOut) {
        if (block.timestamp < lastDrip + DRIP_PERIOD) revert TooSoon(lastDrip + DRIP_PERIOD);

        hypeOut = (reserve * dripBps) / BPS;
        if (hypeOut == 0) revert NothingToDrip();

        uint256 ratioBefore = backingPerSpore();

        sporesOut = _mintableFor(hypeOut);

        reserve -= hypeOut;
        backing += hypeOut;
        totalDripped += hypeOut;
        lastDrip = uint64(block.timestamp);

        if (sporesOut > 0) {
            address to = distributor == address(0) ? owner() : distributor;
            spores.mint(to, sporesOut);
        }

        // The invariant, asserted rather than assumed.
        if (backingPerSpore() < ratioBefore) revert BackingWouldFall();

        emit Dripped(hypeOut, sporesOut, reserve);
    }

    // ---------------------------------------------------------------- redeem

    /// @notice Burn SPORES, take the matching slice of backing. Always open —
    ///         no cooldown, no pause, no owner switch. A floor you can be
    ///         stopped from reaching is not a floor.
    function redeem(uint256 amount) external nonReentrant returns (uint256 hypeOut) {
        if (amount == 0) revert ZeroAmount();

        uint256 supply = spores.totalSupply();
        hypeOut = (amount * backing) / supply;
        if (hypeOut == 0) revert ZeroAmount();

        // Burn first, then pay: supply and backing fall together, ratio holds.
        spores.burnFrom(msg.sender, amount);
        backing -= hypeOut;
        totalRedeemed += hypeOut;

        (bool ok, ) = msg.sender.call{value: hypeOut}("");
        if (!ok) revert TransferFailed();

        emit Redeemed(msg.sender, amount, hypeOut);
    }

    // ------------------------------------------------------------------ burn

    /// @notice Destroy SPORES without paying out, leaving its HYPE in backing.
    ///         Called by the farm when a player fertilises a plot. This is the
    ///         mechanic that lifts backingPerSpore for everyone else.
    function burnForBoost(address from, uint256 amount) external {
        if (msg.sender != distributor) revert NotDistributor();
        spores.burnFrom(from, amount);
        // backing deliberately untouched — that is the entire point
    }

    // ----------------------------------------------------------------- admin

    function setDistributor(address d) external onlyOwner {
        distributor = d;
        emit DistributorSet(d);
    }

    /// @notice Tune the release rate within hard bounds. Cannot be set to drain
    ///         the reserve in one go, and cannot be set to zero to starve it.
    function setDripBps(uint256 bps) external onlyOwner {
        if (bps < MIN_DRIP_BPS || bps > MAX_DRIP_BPS) revert BadDripBps();
        dripBps = bps;
        emit DripBpsSet(bps);
    }

    /// @notice Recover HYPE that arrived by force rather than through fund().
    ///         Cannot touch reserve or backing, so it can never reduce what
    ///         holders can redeem.
    function sweepUnaccounted() external onlyOwner nonReentrant {
        uint256 amt = unaccounted();
        if (amt == 0) revert ZeroAmount();
        (bool ok, ) = owner().call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit Swept(amt);
    }
}
