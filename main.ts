// TideScalp — a defensive paper-trading scalp bot for pump.fun bonding curves.
//
// Idea: most new coins die fast, so the bot only ever risks a small fixed stake on a
// coin shortly after it launches, and only when its first few slots look healthy:
// real buyers are arriving, the creator is not selling, and the price has not already
// run away. Every exit is decided before entry: a tight stop, a partial take-profit
// that leaves a trailing tail, a creator-sell exit, and a short maximum hold. The bot
// never chases, never adds to a loser, and never holds more than four coins at once,
// so a bad tape costs a few percent while a good tape still leaves runners on.
//
// How it runs: the harness sends a hello first, then one batch per slot. Each batch
// carries that slot's events, marks and fills; the bot answers with its orders for
// the slot (at most hello.caps.max_orders_per_batch of them). Orders fill two slots
// later (latency_slots), so every decision is made on slightly stale reserves and
// slippage is kept modest. All amounts are paper SOL; nothing here spends real money.
//
// Price is read off the curve's virtual reserves: price = virtual SOL / virtual
// tokens. A position's return is its current token value at that price over the SOL
// it cost (fees included, as the account reports it).

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const STAKE = (SOL * 4n) / 100n; // 0.04 SOL per scalp.
const PROBE_STAKE = (SOL * 12n) / 1000n; // 0.012 SOL probe, guardrail backstop only.
const MIN_BUY = SOL / 200n; // 0.005 SOL: the guardrail's minimum round-trip size.
const MAX_OPEN = 4; // At most four coins held (or bought) at once.
const DECIDE_FROM_SLOT = 2; // First slot a coin may be bought (age in slots).
const DECIDE_UNTIL_SLOT = 8; // Last slot a coin may be bought; then it is dropped.
const MIN_BUYERS = 3; // Distinct non-creator buyers seen before entry.
const MIN_REAL_SOL = 0.3; // Real SOL in the curve at decision time, lower bound.
const MAX_REAL_SOL = 40; // ...and upper bound: skip curves that are already huge.
const MAX_RUNUP_BPS = 8_000; // Skip coins already up more than +80% from launch.
const STOP_BPS = -1_000; // Stop-loss: sell everything at -10%.
const TAKE_BPS = 2_000; // Take-profit: sell 60% at +20%, trail the rest.
const TRAIL_DROP_BPS = 1_800; // Sell the tail once it falls 18 points off its peak.
const MAX_HOLD_SLOTS = 24; // A plain position is closed after 24 slots.
const TAIL_HOLD_SLOTS = 400; // A tailed runner may live up to 400 slots.
const STALE_TAIL_SLOTS = 120; // Sell a tail with no trade in its coin for 120 slots.
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1_000;
const PROBE_AFTER_COINS = 1_500; // Enable probe mode after this many coins seen...
const PROBE_MIN_ROUND_TRIPS = 20; // ...if round trips are still below the guardrail.

// Per-coin launch record, built from the batch events as they arrive.
interface Coin {
  creator: string;
  createdSlot: number;
  startPrice: number; // Virtual SOL per virtual token at creation.
  buyers: Set<string>;
  creatorSold: boolean;
  netFlowSol: number; // Buys minus sells, in SOL.
  trades: number;
  lastTradeSlot: number;
  decided: boolean;
  probe: boolean;
}

// Per-position exit state, keyed by mint.
interface Held {
  entrySlot: number;
  peakBps: number; // Best return seen so far, in basis points.
  tailArmed: boolean;
  lastTradeSlot: number;
}

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
let coinsSeen = 0;
let roundTrips = 0;
let soldMints = new Set<string>();

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const q = Number(curve.virtual_quote_reserves);
  const t = Number(curve.virtual_token_reserves);
  if (t <= 0) return 0;
  return q / t;
}

function retBps(costLamports: bigint, tokens: bigint, price: number): number {
  if (costLamports <= 0n || price <= 0) return 0;
  const value = Number(tokens) * price; // Lamports of SOL the tokens are worth now.
  return Math.round(((value - Number(costLamports)) / Number(costLamports)) * 10_000);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const slot = batch.slot;
    const orders: Array<BuyInput | SellInput> = [];

    // --- Fold this batch's events into the per-coin launch records. ---
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coinsSeen += 1;
        const startPrice =
          Number(e.virtual_token_reserves) > 0
            ? Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves)
            : 0;
        coins.set(e.mint, {
          creator: e.creator,
          createdSlot: e.slot,
          startPrice,
          buyers: new Set(),
          creatorSold: false,
          netFlowSol: 0,
          trades: 0,
          lastTradeSlot: e.slot,
          decided: false,
          probe: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(BigInt(e.sol_amount)) / 1e9;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        if (e.is_buy) {
          c.netFlowSol += sol;
          if (e.user !== c.creator) c.buyers.add(e.user);
        } else {
          c.netFlowSol -= sol;
          if (e.user === c.creator) c.creatorSold = true;
        }
      } else if (e.event === 'CompleteEvent') {
        coins.delete(e.mint);
        held.delete(e.mint);
      }
    }

    // --- Count round trips from fills: a sell fill closes one. ---
    for (const f of batch.fills) {
      if (f.side === 'sell' && f.status === 'filled') {
        roundTrips += 1;
        soldMints.add(f.mint);
      }
    }
    // Positions the harness flattened or wrote off are gone too.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // --- Exits first: manage every open position before opening new ones. ---
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve);
      const r = retBps(pos.cost_lamports, pos.token_amount, price);
      let h = held.get(mint);
      if (h === undefined) {
        h = { entrySlot: slot, peakBps: r, tailArmed: false, lastTradeSlot: slot };
        held.set(mint, h);
      }
      if (r > h.peakBps) h.peakBps = r;
      const c = coins.get(mint);
      if (c !== undefined) h.lastTradeSlot = c.lastTradeSlot;

      const age = slot - h.entrySlot;
      const creatorDumped = c !== undefined && c.creatorSold;
      let sellTokens = 0n;
      if (creatorDumped || r <= STOP_BPS) {
        sellTokens = pos.token_amount; // Creator sold, or the stop hit: out in full.
      } else if (!h.tailArmed && r >= TAKE_BPS) {
        sellTokens = (pos.token_amount * 3n) / 5n; // Take 60% off at +20%, trail the rest.
        h.tailArmed = true;
      } else if (h.tailArmed) {
        // Trailing stop: sell once the tail falls 18 points off its peak. Because the
        // tail only arms at +20%, that stop can never sit below +2%: the floor is built in.
        const trailedOff = h.peakBps - r >= TRAIL_DROP_BPS;
        const stale = slot - h.lastTradeSlot >= STALE_TAIL_SLOTS;
        const expired = age >= TAIL_HOLD_SLOTS;
        if (trailedOff || stale || expired) sellTokens = pos.token_amount;
      } else if (age >= MAX_HOLD_SLOTS) {
        sellTokens = pos.token_amount; // Time stop for a position going nowhere.
      }
      if (sellTokens > 0n) {
        orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // --- Entries: grade each undecided coin once, in this batch's event order. ---
    const probeMode = coinsSeen >= PROBE_AFTER_COINS && roundTrips < PROBE_MIN_ROUND_TRIPS;
    let free = state.freeCashLamports();
    // Sells above free no cash, but pending buys do; count open slots net of sells.
    let openSlots = MAX_OPEN - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const c = coins.get(e.mint);
      if (c === undefined || c.decided) continue;
      const age = slot - c.createdSlot;
      if (age < DECIDE_FROM_SLOT) continue;
      if (age > DECIDE_UNTIL_SLOT) {
        c.decided = true;
        continue;
      }
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        c.decided = true;
        continue;
      }
      const realSol = Number(curve.real_quote_reserves) / 1e9;
      const price = priceOf(curve);
      const runupBps =
        c.startPrice > 0 && price > 0 ? Math.round(((price - c.startPrice) / c.startPrice) * 10_000) : 0;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY) continue; // Too small to buy meaningfully yet; decide next slot.

      const healthy =
        !c.creatorSold &&
        c.buyers.size >= MIN_BUYERS &&
        c.netFlowSol > 0 &&
        realSol >= MIN_REAL_SOL &&
        realSol <= MAX_REAL_SOL &&
        runupBps <= MAX_RUNUP_BPS;
      const probeOk = probeMode && !c.creatorSold && c.buyers.size >= 1 && c.netFlowSol > 0;
      if (!healthy && !probeOk) continue;

      const stake = probeOk && !healthy ? PROBE_STAKE : STAKE;
      const amount = cap < stake ? cap : stake;
      if (openSlots <= 0 || free < amount + tx) continue;
      c.decided = true;
      c.probe = probeOk && !healthy;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      openSlots -= 1;
    }

    return orders;
  },
});
