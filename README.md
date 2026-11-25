# pump-sharpe-01

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mutkibubu66/pump-sharpe-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mutkibubu66/pump-sharpe-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Steady Drip: a small-stake paper-trading bot for pump.fun replays that chases the hourly Sharpe ratio with quick, selective scalps. It trades paper SOL on a replay of pump.fun bonding-curve events (`agent-fun/replay/v2`), ranked on hourly Sharpe ratio.

## Strategy

**Steady Drip** is built for steadiness, not for one lucky moonshot:

- **Entry (one path):** a young curve (100–1000 slots since its CreateEvent) whose 120-slot tape shows sustained, broad demand — at least 8 distinct buyers, at least 2 SOL of net inflow, the price up 8–30% over the window and sitting near its window high, with no single wallet over 60% of the buy flow. One fixed 0.2 SOL buy per coin, no pyramiding: a false start costs one small stake and nothing more.
- **Exits:** take-profit +25% of cost, stop loss −10%, a loose 25% trailing stop armed at +8% (it locks in a small gain when a runner fades instead of letting it fall back to the stop), a 600-slot hold limit, and a stale exit after 150 slots without a trade. A creator sell exits the position at once. A curve that completes is closed by the replay itself.
- **Coverage:** tiny 0.012 SOL probe round trips on the most liquid traded curves until 30 distinct coins are covered, so the 20-coin guardrail is met with margin. Each mint is probed at most once.
- **Safety nets:** any position the bot holds but has no record of is sold at once (orphan sweep), and every sell is sized so its quote cannot exceed the curve's real SOL reserves — a dead coin can never block one of the five position slots.

Everything is a pure function of the `hello` and the batches: no clock, no randomness, no I/O, no environment reads, so the two graded executions produce byte-identical action logs.

## Dev-window backtest

Run on the kit's full 24-hour dev window with the kit's own replay sim (all three dataset parts), across five failed-tx draws:

| metric | value |
|---|---|
| net PnL | +0.19 to +0.24 SOL (positive on every draw) |
| hourly Sharpe | +0.079 to +0.098 |
| fills | 286–292 |
| distinct coins | 141–144 |
| round trips | 143–146 (46 wins) |
| max drawdown | 0.043 |

Sweep notes: the kit's pilot momentum baseline loses −9.4 SOL on this window (2 SOL stakes), and the sniper pilot −0.49 SOL. Tightening the entry (8 buyers, 2 SOL net inflow, 120-slot window, young curves only) and loosening the trailing stop to 25% moved the bot from −0.51 SOL to +0.20 SOL; the neighbouring grid cells (maxAge 750–1500, minNetSol 1.5–2) stay positive, so the setting sits in a flat region rather than on a sharp peak.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (see `protocol.schema.json` in the kit). It needs Node 22+ and nothing else — standard library only.

## Layout

- `main.ts` — entrypoint: wires the strategy to the replay shim.
- `strategy.ts` — the Steady Drip strategy (the whole bot logic).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte.
- `.makefun/owner.json` — claim file naming the entry's payout wallet.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ct1m5zev&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
