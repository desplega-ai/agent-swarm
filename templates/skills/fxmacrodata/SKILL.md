---
name: fxmacrodata
description: Official macroeconomic releases (CPI, policy rates, payrolls, GDP), release calendars and FX rates for 22 currencies through the FXMacroData REST API. Use when the answer is a published number, the time it was or will be released, or a currency pair's rate.
---

# FXMacroData

FXMacroData (https://fxmacrodata.com) serves central-bank and statistics-office data for 22 currencies over one REST API: each indicator's release history with publication times, a forward release calendar, the indicator catalogue per currency, and daily FX rates. API reference: https://fxmacrodata.com/documentation

## When to use FXMacroData vs. WebSearch

| Question | Use |
|---|---|
| "What did US CPI print for August, and when was it published?" | **FXMacroData** release history |
| "When is the next payrolls report?" | **FXMacroData** calendar |
| "Which indicators exist for the euro area?" | **FXMacroData** catalogue |
| "Where did EUR/USD close yesterday?" | **FXMacroData** FX rates (key required) |
| "Why did the market react to the CPI print?" | WebSearch (commentary, not data) |

A news article quotes a number once, often rounded and without the reference period. The API returns the official value, the previous value, the period it describes and the exact publication time, so use it whenever the number itself is the answer.

## Step 1. Get the API key (optional)

```bash
# Via MCP tool (preferred, handles secret resolution)
mcp__agent-swarm__get-config(key="FXMACRODATA_API_KEY", includeSecrets=true)
```

The value comes back at `configs[0].value`. If it is not set, keep going: without a key the API still answers for USD releases from the last 90 days (each release readable 15 minutes after publication), the USD release calendar, and every currency's catalogue. Other currencies, full history, real-time releases and FX rates need a key from https://fxmacrodata.com/subscribe

Send the key as a header and never in the URL:

```bash
AUTH=()
[ -n "$FXMACRODATA_API_KEY" ] && AUTH=(-H "X-API-Key: $FXMACRODATA_API_KEY")
```

## Step 2. Find the indicator slug

```bash
curl -sS "https://api.fxmacrodata.com/v1/data_catalogue/usd" "${AUTH[@]}"
```

The response is an object keyed by indicator slug (`inflation`, `policy_rate`, `non_farm_payrolls`, `gdp`, `unemployment`, `gov_bond_10y`...). Each entry has `name`, `unit`, and a `coverage` object with `latest_available_date` and `requires_api_key`. Use the slug, not the display name, in the next calls.

## Step 3. Release history

```bash
curl -sS "https://api.fxmacrodata.com/v1/announcements/usd/inflation?start_date=2026-01-01&limit=12" "${AUTH[@]}"
```

Rows land in `data[]`:

- `date` is the reference period the figure describes (end of the month or quarter), not the day it was published.
- `val` is the value and `previous_value` the prior print.
- `announcement_datetime` is the publication time as Unix seconds, `announcement_datetime_local` the same instant in the publisher's timezone.
- `source_url` links the official release.

`limit` is at most 100. When `pagination.has_more` is `true`, call again with `offset` set to the number of rows already read.

Keyless responses carry `freemium_window` (history cut to 90 days) and `freemium_delay` (releases from the last 15 minutes withheld, with `withheld_count`). When either has `"applied": true`, say so in the answer instead of presenting the newest row as the latest release.

## Step 4. Release calendar

```bash
curl -sS "https://api.fxmacrodata.com/v1/calendar/usd?indicator=non_farm_payrolls" "${AUTH[@]}"
```

Each row in `data[]` has `release` (the slug), `name`, `announcement_datetime_utc`, `reference_period` (for example `"October 2026"`) and `event_importance`. Drop `indicator=` to get every scheduled USD release. Report times from `announcement_datetime_utc`; `date` is again the reference period.

## Step 5. FX rates (key required)

```bash
curl -sS "https://api.fxmacrodata.com/v1/forex/eur/usd?start_date=2026-09-01" "${AUTH[@]}"
```

Rows in `data[]` carry `date` and `val`. Without a key this returns HTTP 401 with `"code": "api_key_required"`.

## Discipline: no fabrication

If a call returns no rows, or a 401 says a key is required, report that. Do not fill the gap with a remembered or estimated figure. A missing number is a finding; a made-up one is a wrong answer.

## Quick gotchas

- The header is `X-API-Key`. The `?api_key=` query parameter is deprecated because keys in URLs end up in logs.
- `date` is the reference period everywhere. A June CPI row has `date: 2026-06-30` and was published in July.
- An unknown slug returns 404, and the `detail` text suggests close matches (`nfp` points to `non_farm_payrolls`). The catalogue is the reliable list.
- The API is for server-side calls and sends no CORS headers, so it will not work from a browser page.
