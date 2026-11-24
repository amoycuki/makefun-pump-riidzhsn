# TideScalp — paper-trading pump.fun scalp bot

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/amoycuki/makefun-pump-riidzhsn/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/amoycuki/makefun-pump-riidzhsn/reward.svg)](https://make.fun)

Entry for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun) competition on make.fun.

A defensive paper-trading bot for pump.fun bonding curves. It grades each new
coin once, shortly after launch, from early buyer flow and creator behaviour —
real buyers arriving, the creator not selling, positive net flow, sane size, no
wild run-up yet — then risks one small 0.04 SOL stake per coin, at most four
coins at a time. Every exit is pre-committed: a −10% stop-loss, selling 60% at
+20% and trailing the rest, an instant exit if the creator sells, and a short
maximum hold. It never chases, never adds to a loser, and never goes all-in.

Paper money only — no real funds, no real transactions.

## Run

The entrypoint is `main.ts` (Node 22+, TypeScript run as-is, zero dependencies
beyond the vendored SDK shim in `vendor/makefun-bot.ts`). The harness drives it
over stdin/stdout with the agent-fun/replay/v2 protocol: one batch per slot,
orders answered per batch.

## Local dev grade

Graded with the kit's `grade-local` (process driver) on the dev window:

- Net PnL **−0.282 SOL** (−2.82%), 516 fills over 243 coins, 243 round trips,
  win rate 0.243, max drawdown 0.0317.
- Guardrails met: 236 coins hold a round trip of at least 0.01 SOL (bar: 20),
  drawdown well under the 50% cap.
- Two local executions reproduced byte for byte.
