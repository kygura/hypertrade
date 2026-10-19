import type { EdgeType } from "../../shared/intel.js";

// Seed exposure graph (docs/SPEC.md § Intel I0.8). Shipped in code, upserted
// idempotently by ensureSeedEdges (graph.ts) with origin "seed". Direction
// reads "src is exposed to dst through type" (jitoSOL is collateral-exposed
// to SOL); the walk itself is undirected (graph.ts). Asset nodes use the
// Hyperliquid coin name (kPEPE, kBONK), with a direct edge to the name news
// uses (PEPE), so a headline reaches the perp in one hop. `source` is the doc
// page that backs the edge.

export interface SeedEdge {
  src: string;
  dst: string;
  type: EdgeType;
  source: string;
}

const DOC = {
  bitcoin: "https://bitcoin.org/en/how-it-works",
  ethereum: "https://ethereum.org/en/developers/docs/",
  solana: "https://solana.com/docs",
  hyperliquid: "https://hyperliquid.gitbook.io/hyperliquid-docs",
  hlBridge: "https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-start-trading",
  hype: "https://hyperliquid.gitbook.io/hyperliquid-docs/hype-staking",
  arbitrum: "https://docs.arbitrum.io/",
  optimism: "https://docs.optimism.io/",
  base: "https://docs.base.org/",
  avalanche: "https://build.avax.network/docs",
  sui: "https://docs.sui.io/",
  xrpl: "https://xrpl.org/docs",
  bnb: "https://docs.bnbchain.org/",
  binance: "https://www.binance.com/en/bnb",
  celestia: "https://docs.celestia.org/",
  jupiter: "https://station.jup.ag/docs",
  chainlink: "https://docs.chain.link/",
  bittensor: "https://docs.bittensor.com/",
  ethena: "https://docs.ethena.fi/",
  usde: "https://docs.ethena.fi/solution-overview/usde-overview",
  ondo: "https://docs.ondo.finance/",
  dogecoin: "https://dogecoin.com/",
  dogwifhat: "https://dogwifcoin.org/",
  pepe: "https://www.pepe.vip/",
  bonk: "https://bonkcoin.com/",
  kTokens: "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications",
  circle: "https://www.circle.com/usdc",
  tether: "https://tether.to/en/transparency/",
  lido: "https://docs.lido.fi/",
  jito: "https://www.jito.network/docs/jitosol/overview/",
  marinade: "https://docs.marinade.finance/",
  aave: "https://aave.com/docs",
  aiCategory: "https://www.coingecko.com/en/categories/artificial-intelligence",
  memeCategory: "https://www.coingecko.com/en/categories/meme-token",
  rwaCategory: "https://www.coingecko.com/en/categories/real-world-assets-rwa",
  l2Category: "https://www.coingecko.com/en/categories/layer-2",
  macroBeta: "https://www.imf.org/en/Blogs/Articles/2022/01/11/crypto-prices-move-more-in-sync-with-stocks-posing-new-risks",
} as const;

export const SEED_EDGES: readonly SeedEdge[] = [
  // Core assets and the names headlines use for them.
  { src: "BTC", dst: "Bitcoin", type: "direct", source: DOC.bitcoin },
  { src: "ETH", dst: "Ethereum", type: "direct", source: DOC.ethereum },
  { src: "SOL", dst: "Solana", type: "direct", source: DOC.solana },
  { src: "HYPE", dst: "Hyperliquid", type: "direct", source: DOC.hype },
  { src: "AVAX", dst: "Avalanche", type: "direct", source: DOC.avalanche },
  { src: "SUI", dst: "Sui", type: "direct", source: DOC.sui },
  { src: "XRP", dst: "XRP Ledger", type: "direct", source: DOC.xrpl },
  { src: "BNB", dst: "BNB Chain", type: "direct", source: DOC.bnb },
  { src: "BNB", dst: "Binance", type: "direct", source: DOC.binance },
  { src: "TIA", dst: "Celestia", type: "direct", source: DOC.celestia },
  { src: "LINK", dst: "Chainlink", type: "direct", source: DOC.chainlink },
  { src: "TAO", dst: "Bittensor", type: "direct", source: DOC.bittensor },
  { src: "DOGE", dst: "Dogecoin", type: "direct", source: DOC.dogecoin },
  { src: "WIF", dst: "dogwifhat", type: "direct", source: DOC.dogwifhat },
  { src: "kPEPE", dst: "PEPE", type: "direct", source: DOC.kTokens },
  { src: "kBONK", dst: "BONK", type: "direct", source: DOC.kTokens },
  { src: "PEPE", dst: "Pepe", type: "direct", source: DOC.pepe },
  { src: "BONK", dst: "Bonk", type: "direct", source: DOC.bonk },
  { src: "ONDO", dst: "Ondo", type: "direct", source: DOC.ondo },

  // Perp DEXs and venues.
  { src: "Hyperliquid", dst: "USDC", type: "depends_on_stable", source: DOC.hlBridge },
  { src: "Hyperliquid", dst: "Arbitrum", type: "bridge", source: DOC.hlBridge },
  { src: "HYPE", dst: "Hyperliquid", type: "primary_venue", source: DOC.hyperliquid },
  { src: "JUP", dst: "Jupiter", type: "direct", source: DOC.jupiter },
  { src: "Jupiter", dst: "SOL", type: "settles_on", source: DOC.jupiter },
  { src: "Jupiter", dst: "USDC", type: "depends_on_stable", source: DOC.jupiter },
  { src: "BNB", dst: "Binance", type: "primary_venue", source: DOC.binance },

  // L2s settle on Ethereum; their tokens are the L2 itself.
  { src: "Arbitrum", dst: "ETH", type: "settles_on", source: DOC.arbitrum },
  { src: "Optimism", dst: "ETH", type: "settles_on", source: DOC.optimism },
  { src: "Base", dst: "ETH", type: "settles_on", source: DOC.base },
  { src: "ARB", dst: "Arbitrum", type: "direct", source: DOC.arbitrum },
  { src: "OP", dst: "Optimism", type: "direct", source: DOC.optimism },

  // Tokens and the chain they settle on.
  { src: "LINK", dst: "ETH", type: "settles_on", source: DOC.chainlink },
  { src: "ONDO", dst: "ETH", type: "settles_on", source: DOC.ondo },
  { src: "ENA", dst: "ETH", type: "settles_on", source: DOC.ethena },
  { src: "PEPE", dst: "ETH", type: "settles_on", source: DOC.pepe },
  { src: "WIF", dst: "SOL", type: "settles_on", source: DOC.dogwifhat },
  { src: "BONK", dst: "SOL", type: "settles_on", source: DOC.bonk },
  { src: "JUP", dst: "SOL", type: "settles_on", source: DOC.jupiter },
  { src: "Solana", dst: "SOL", type: "direct", source: DOC.solana },
  { src: "Ethereum", dst: "ETH", type: "direct", source: DOC.ethereum },

  // Stablecoins: issuer, and what backs them.
  { src: "USDC", dst: "Circle", type: "direct", source: DOC.circle },
  { src: "USDT", dst: "Tether", type: "direct", source: DOC.tether },
  { src: "USDe", dst: "Ethena", type: "direct", source: DOC.usde },
  { src: "ENA", dst: "Ethena", type: "direct", source: DOC.ethena },
  { src: "USDe", dst: "ETH", type: "collateral", source: DOC.usde },
  { src: "USDe", dst: "BTC", type: "collateral", source: DOC.usde },
  { src: "USDe", dst: "USDT", type: "depends_on_stable", source: DOC.usde },

  // Liquid staking tokens: issuer, and the asset they are collateral for.
  { src: "stETH", dst: "Lido", type: "direct", source: DOC.lido },
  { src: "stETH", dst: "ETH", type: "collateral", source: DOC.lido },
  { src: "stETH", dst: "Aave", type: "collateral", source: DOC.aave },
  { src: "jitoSOL", dst: "Jito", type: "direct", source: DOC.jito },
  { src: "jitoSOL", dst: "SOL", type: "collateral", source: DOC.jito },
  { src: "Jito", dst: "SOL", type: "settles_on", source: DOC.jito },
  { src: "mSOL", dst: "Marinade", type: "direct", source: DOC.marinade },
  { src: "mSOL", dst: "SOL", type: "collateral", source: DOC.marinade },

  // Narratives.
  { src: "TAO", dst: "AI", type: "narrative", source: DOC.aiCategory },
  { src: "FET", dst: "AI", type: "narrative", source: DOC.aiCategory },
  { src: "RENDER", dst: "AI", type: "narrative", source: DOC.aiCategory },
  { src: "VIRTUAL", dst: "AI", type: "narrative", source: DOC.aiCategory },
  { src: "DOGE", dst: "memes", type: "narrative", source: DOC.memeCategory },
  { src: "WIF", dst: "memes", type: "narrative", source: DOC.memeCategory },
  { src: "kPEPE", dst: "memes", type: "narrative", source: DOC.memeCategory },
  { src: "kBONK", dst: "memes", type: "narrative", source: DOC.memeCategory },
  { src: "ONDO", dst: "RWA", type: "narrative", source: DOC.rwaCategory },
  { src: "LINK", dst: "RWA", type: "narrative", source: DOC.rwaCategory },
  { src: "ARB", dst: "L2", type: "narrative", source: DOC.l2Category },
  { src: "OP", dst: "L2", type: "narrative", source: DOC.l2Category },
  { src: "TIA", dst: "L2", type: "narrative", source: DOC.l2Category },

  // Macro beta.
  { src: "BTC", dst: "DXY", type: "macro_beta", source: DOC.macroBeta },
  { src: "BTC", dst: "NASDAQ", type: "macro_beta", source: DOC.macroBeta },
  { src: "ETH", dst: "DXY", type: "macro_beta", source: DOC.macroBeta },
  { src: "ETH", dst: "NASDAQ", type: "macro_beta", source: DOC.macroBeta },
];
