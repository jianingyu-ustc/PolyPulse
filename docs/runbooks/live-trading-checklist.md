# Live Trading Checklist

Use this checklist before any command that may submit real orders.

## Environment

```bash
node ./bin/polypulse.js env check --env-file .env
```

Confirm:

- `POLYPULSE_MARKET_SOURCE=polymarket`
- `POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com`
- `CHAIN_ID=137`

## Current Markets

```bash
node ./bin/polypulse.js market topics --env-file .env --limit 20 --quick
```

Choose a returned `marketId` or `marketSlug`.

## Prediction

```bash
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>
```

Review probability, implied probability, net edge, fees, Kelly sizing, monthly
return, confidence, and artifacts.

## Real Wallet Balance

Only for `POLYPULSE_LIVE_WALLET_MODE=real`:

```bash
node ./bin/polypulse.js account balance --env-file .env
node ./bin/polypulse.js account audit --env-file .env
```

Proceed only if `account audit` returns `ok=true` with no blocking reasons for
collateral, allowance, open position exposure, historical trades, win rate,
net return, or market readability.

Run only after explicit operator approval if CLOB collateral allowance is
insufficient:

```bash
node ./bin/polypulse.js account approve --env-file .env --confirm APPROVE
```

## One-Time Execution

Run only after explicit operator approval for real funds:

```bash
node ./bin/polypulse.js trade once --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
```

## Monitor

```bash
node ./bin/polypulse.js monitor run --env-file .env --confirm LIVE --loop
```

Stop and resume:

```bash
node ./bin/polypulse.js monitor stop --env-file .env --reason manual_stop
node ./bin/polypulse.js monitor resume --env-file .env
```
