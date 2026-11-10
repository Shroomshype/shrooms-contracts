/* Reproduces the numbers on the tokenomics page. Same model, same assumptions —
   if you change one, change site/js/tokenomics.js too.

   The fee curve has two parts: a launch spike that fades and an organic baseline
   that does not. The baseline is what gives the protocol a steady state instead
   of a countdown, and it is the single most important assumption here. */

const WEEKS = 52;
const ORGANIC = 7;      // HYPE/wk of fees from steady trading
const SPIKE = 40;       // launch excitement, decaying
const DECAY = 0.82;
const FEE_RATE = 0.01;  // Montra's trade fee, confirmed 1%: 100 HYPE traded -> 1 HYPE in
const TREASURY_SHARE = 0.5; // half the fee funds rewards; half funds team + marketing
const BOOT = 10e6, CAP = 1e9, SOLD = 0.55, BURNED = 0.25;

function run(drip) {
  let reserve = 0, backing = 0, supply = 0, burned = 0;
  const rows = [];
  for (let w = 1; w <= WEEKS; w++) {
    const gross = ORGANIC + SPIKE * Math.pow(DECAY, w - 1);
    const fees = gross * TREASURY_SHARE;
    reserve += fees;
    const move = reserve * drip;
    reserve -= move;

    let minted = (supply === 0 || backing === 0) ? move * BOOT : (move * supply) / backing;
    minted = Math.min(minted, Math.max(0, CAP - supply));
    backing += move;
    supply += minted;

    const b = minted * BURNED;
    supply -= b;
    burned += b;

    const sold = minted * SOLD;
    const out = supply > 0 ? (sold * backing) / supply : 0;
    supply -= sold;
    backing -= out;

    rows.push({ w, fees, gross, volume: gross / FEE_RATE, rewards: minted, floor: backing / supply, supply, reserve, backing, burned });
  }
  return rows;
}

const drip = run(0.02);
const pass = run(1.0);

console.log("Shrooms — year one\n");
console.log("wk   fees(H)   volume(H)    rewards      floor     reserve   burned");
console.log("-".repeat(74));
for (const w of [1, 4, 8, 13, 26, 39, 52]) {
  const r = drip[w - 1];
  console.log(
    String(w).padStart(3),
    r.fees.toFixed(1).padStart(8),
    r.volume.toFixed(0).padStart(11),
    r.rewards.toExponential(2).padStart(11),
    r.floor.toExponential(2).padStart(10),
    r.reserve.toFixed(0).padStart(9),
    (r.burned / 1e6).toFixed(1).padStart(8) + "M"
  );
}

const peak = Math.max(...drip.map(r => r.rewards));
const peakPass = Math.max(...pass.map(r => r.rewards));
console.log("\nFloor:     ", drip[0].floor.toExponential(2), "->", drip[51].floor.toExponential(2),
            `(${(drip[51].floor / drip[0].floor).toFixed(1)}x)`);
console.log("Rewards at week 52, as a share of peak:");
console.log("  drip 2%/wk       ", (drip[51].rewards / peak * 100).toFixed(1) + "%");
console.log("  spend on arrival ", (pass[51].rewards / peakPass * 100).toFixed(2) + "%");
console.log("Reserve equilibrium:", (ORGANIC * TREASURY_SHARE / 0.02).toFixed(0), "HYPE (weekly treasury income / drip rate)");
console.log("Treasury share of the 1% fee:", (TREASURY_SHARE*100)+"% — the rest funds team and marketing");
console.log("SPORES burned in year one:", (drip[51].burned / 1e6).toFixed(1) + "M");
