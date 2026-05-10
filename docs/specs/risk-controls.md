# Risk Controls

Last updated: 2026-05-06

## Live Gates

- Execution mode must be `live`.
- `POLYPULSE_MARKET_SOURCE` must be `polymarket`.
- `POLYMARKET_GAMMA_HOST` must point to a real Gamma API host.
- Chain id must be `137`.
- `--confirm LIVE` is required for executable orders.
- `live` mode requires `PRIVATE_KEY`, `FUNDER_ADDRESS`, `SIGNATURE_TYPE`, and
  `POLYMARKET_HOST`.
- `live` mode must pass `account audit` before real execution. Audit verifies
  CLOB collateral, allowance, remote positions, remote trades, local
  cancellations/rejections, win rate, net return, and drawdown.
- `paper` mode connects to the real wallet for balance reads and uses the real
  balance as the starting point for its internal ledger.

## Market Gates

- Market must be active, open, tradable, and have CLOB token ids.
- Market data age is checked before execution.
- Liquidity must support the requested notional after caps.

## Portfolio Gates

- Single trade, total exposure, event exposure, drawdown, position count, and
  minimum notional limits are enforced in `RiskEngine`.
- `live` mode buy orders require sufficient CLOB collateral and allowance.
- `paper` mode buy orders require sufficient balance in the internal ledger.

## AI Boundary

- AI providers only return probability and evidence judgment.
- AI output cannot override token id, side, notional, broker options, or balance.
