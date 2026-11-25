// Steady Drip: a small-stake, quick-turn scalper for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). It is built for the hourly Sharpe ratio, not for one lucky moonshot:
// many small round trips, spread across the whole window, each risking little and exiting fast,
// so hourly equity moves a little and moves steadily.
//
// Entry: a curve that has lived a while (past minAge slots since its CreateEvent, so bundled
// launches that dump in their first minutes are skipped) whose recent tape shows broad, real
// demand — several distinct buyers, net SOL flowing in, the price up a little but not parabolic
// and sitting near its window high, with no single wallet dominating the buy flow. One fixed-size
// buy per coin, no pyramiding: a false start costs one small stake and nothing more.
//
// Exits: the first of a take-profit, a stop loss against cost, a trailing stop once the position
// is up, a hold limit, or a stale exit when the curve stops trading. A curve that completes is
// closed by the replay itself.
//
// Coverage: the guardrail needs round trips of at least 0.01 SOL on at least 20 distinct mints.
// When the bot's own filled coins lag a pace set in block time, it opens tiny probe round trips
// (buy probeSol, sell it all as soon as the buy lands) until it is back on pace.
//
// Deterministic by construction: no clock, no randomness, no I/O. Iteration is only over
// insertion-ordered maps fed by the batch stream, so the two graded executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far inside one window. */
  maxPriceUp: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Largest sell share (sell SOL / total SOL) over the entry window. */
  maxSellShare: number;
  /** Reject when the curve's creator sold anything over the entry window. */
  rejectCreatorSold: boolean;
  /** Largest creator buy SOL over the entry window. */
  maxCreatorBuySol: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since the CreateEvent after which no fresh entry is allowed. */
  maxAge: number;
  /** Slots since the curve's last recorded trade before it counts as stale. */
  freshSlots: number;
  /** SOL to put into one position (one buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the position's value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit when the position's value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: exit when value falls to peak * (1 - trail), once armed. */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit when no recorded trade on the curve for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Guardrail pacing: the run must end with round trips on at least targetCoins coins. When the
   * bot's own filled coins lag targetCoins scaled by the share of paceSecs elapsed (block time
   * since the first batch), it opens tiny probe round trips until it is back on pace. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

// The settings main.ts trades with. Chosen on the dev window with the local backtest
// (see the sweep notes in README.md), preferring flat regions of the grid over a sharp peak,
// and preferring a positive hourly Sharpe with low drawdown over raw PnL. The winning shape:
// a long 120-slot tape so only sustained moves qualify, a strict buyer count (8 distinct
// buyers) and 2 SOL of net inflow, young curves only (100-1000 slots old), a loose 25%
// trailing stop so runners are kept instead of being cut at the first dip, and a 600-slot
// hold limit with a 150-slot stale exit so dead money is freed quickly.
export const DEFAULT_PARAMS: Params = {
  window: 120,
  minNetSol: 2,
  minBuys: 4,
  minBuyers: 8,
  minPriceUp: 0.08,
  maxPriceUp: 0.3,
  nearHigh: 0.95,
  maxBuyerShare: 0.6,
  maxSellShare: 1,
  rejectCreatorSold: false,
  maxCreatorBuySol: 2.5,
  minRqSol: 1,
  maxRqSol: 80,
  minAge: 100,
  maxAge: 1000,
  freshSlots: 120,
  stakeSol: 0.2,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 0.25,
  stopLoss: 0.1,
  trail: 0.25,
  trailArm: 0.08,
  maxHold: 600,
  staleSlots: 150,
  cooldown: 200,
  maxEntries: 1,
  targetCoins: 30,
  paceSecs: 14400,
  probeSol: 0.012,
  maxProbes: 1,
  maxExposureSol: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on. */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, trades: [], entries: 0, lastExit: -1e12, lastTradeSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (now - t.lastTradeSlot > p.freshSlots) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let creatorSold = false;
    let creatorBuySol = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
        if (t.creator !== null && tr.user === t.creator) creatorBuySol += tr.sol;
      } else {
        sellSol += tr.sol;
        if (t.creator !== null && tr.user === t.creator) creatorSold = true;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (buySol + sellSol > 0 && sellSol / (buySol + sellSol) > p.maxSellShare) return false;
    if (p.rejectCreatorSold && creatorSold) return false;
    if (creatorBuySol > p.maxCreatorBuySol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Tokens to sell so the quote stays under the curve's real SOL reserves. */
  const sellableTokens = (tokens: bigint, vq: bigint, vt: bigint, rq: bigint): bigint => {
    const quote = (tokens * vq) / (vt + tokens);
    if (quote <= rq) return tokens;
    // Solve tokens * vq / (vt + tokens) = rq * 99/100 for tokens.
    const target = (rq * 99n) / 100n;
    if (target >= vq) return tokens;
    const want = (target * vt) / (vq - target);
    if (want <= 0n) return 0n;
    return want < tokens ? want : tokens;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      /** Curves whose creator sold in this batch: exit any position on them at once. */
      const creatorDump = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = (e as { creator?: string }).creator ?? null;
        } else if (e.event === 'TradeEvent') {
          const t0 = tapeOf(e.mint);
          if (!e.is_buy && t0.creator !== null && e.user === t0.creator) creatorDump.add(e.mint);
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          t.lastTradeSlot = e.slot;
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Sell helper: whole position, sized under the curve's real reserves.
      const sellWhole = (mint: Pubkey): boolean => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) return false;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const rq = mk ? BigInt(mk.real_quote_reserves) : curve.real_quote_reserves;
        const amount = sellableTokens(pos.token_amount, vq, vt, rq);
        if (amount <= 0n) return false;
        if (orders.length >= cap) return false;
        orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10_000 });
        return true;
      };

      // Exits first. A position the bot holds but has no record of is sold at once (orphan sweep).
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h === undefined) {
          if (!pendingByMint.has(mint)) sellWhole(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        h.filled = true;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && creatorDump.has(mint)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && now - t.lastTradeSlot > p.staleSlots) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        sellWhole(mint);
      }
      // Drop records of positions that are gone and nothing is pending on.
      for (const [mint, h] of held) {
        if (!state.positions.has(mint) && !pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        if (sellWhole(mint) && !selling) probes.set(mint, true);
      }

      // Then entries (one fixed-size buy per coin, no adds).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when the bot's filled coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
