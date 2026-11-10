/* The single source of truth for the strain lineup.
   Imported by deploy-v2.js and drip-and-fund.js, and mirrored by site/js/data.js
   so the page and the chain can never disagree about what a strain is.

   Every strain stakes SHROOMS or the SHROOMS-HYPE LP. That is deliberate: v2's
   reward pot is fixed by fee income, so a pool accepting an outside token would
   hand SHROOMS holders' rewards to people who never bought SHROOMS and generate
   no trading fees. Strains are differentiated by commitment instead of by asset.

   LP strains carry 60% of total weight between them, because liquidity depth is
   what produces the trading volume that funds everything. */

module.exports = [
  // pid, name, what you stake, tier, SPORES burned to enter, emission weight
  { pid: 0, name: "Puffball Patch",    slug: "puffball",    stake: "SHROOMS",    tier: "Common",    gate: "0",      weight: 600  },
  { pid: 1, name: "Inky Cap",          slug: "inky",        stake: "SHROOMS",    tier: "Common",    gate: "25000",  weight: 850  },
  { pid: 2, name: "Morel Deep",        slug: "morel",       stake: "SHROOMS",    tier: "Rare",      gate: "75000",  weight: 1150 },
  { pid: 3, name: "Chanterelle Grove", slug: "chanterelle", stake: "SHROOMS",    tier: "Rare",      gate: "150000", weight: 1500 },
  { pid: 4, name: "Blue Mycena",       slug: "mycena",      stake: "SHROOMS",    tier: "Epic",      gate: "300000", weight: 1900 },
  { pid: 5, name: "Enoki Cluster",     slug: "enoki",       stake: "SHROOMS_LP", tier: "Epic",      gate: "0",      weight: 2300 },
  { pid: 6, name: "Golden Cap",        slug: "golden",      stake: "SHROOMS_LP", tier: "Legendary", gate: "250000", weight: 3000 },
  { pid: 7, name: "Amanita Prime",     slug: "amanita",     stake: "SHROOMS_LP", tier: "Legendary", gate: "600000", weight: 3700 },
];
