# Live Trading Checklist

Use this checklist before any command that may submit real orders.

## Environment

```bash
node ./bin/polypulse.js env check --mode live --env-file .env
```

Confirm:

- `POLYPULSE_EXECUTION_MODE=live`
- `POLYPULSE_MARKET_SOURCE=polymarket`
- `POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com`
- `CHAIN_ID=137`
- `POLYPULSE_LIVE_CONFIRM=LIVE`

## Current Markets

```bash
node ./bin/polypulse.js market topics --env-file .env --limit 20
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
node ./bin/polypulse.js account balance --mode live --env-file .env
```

## One-Time Execution

Run only after explicit operator approval for real funds:

```bash
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
```

## Monitor

```bash
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

Stop and resume:

```bash
node ./bin/polypulse.js monitor stop --mode live --env-file .env --reason manual_stop
node ./bin/polypulse.js monitor resume --mode live --env-file .env
```
