# Risk Controls

Last updated: 2026-05-06

## Live Gates

- Execution mode must be `live`.
- `POLYPULSE_MARKET_SOURCE` must be `polymarket`.
- `POLYMARKET_GAMMA_HOST` must point to a real Gamma API host.
- Chain id must be `137`.
- `--confirm LIVE` is required for executable orders.
- `live real` requires `PRIVATE_KEY`, `FUNDER_ADDRESS`, `SIGNATURE_TYPE`, and
  `POLYMARKET_HOST`.
- `live simulated` requires non-negative `SIMULATED_WALLET_BALANCE_USD`.

## Market Gates

- Market must be active, open, tradable, and have CLOB token ids.
- Market data age is checked before execution.
- Liquidity must support the requested notional after caps.

## Portfolio Gates

- Single trade, total exposure, event exposure, drawdown, position count, and
  minimum notional limits are enforced in `RiskEngine`.
- `live real` buy orders require sufficient CLOB collateral.
- `live simulated` buy orders require sufficient simulated live balance.

## AI Boundary

- AI providers only return probability and evidence judgment.
- AI output cannot override token id, side, notional, broker options, balance, or
  execution mode.
