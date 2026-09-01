# Model Pricing

The checked standard-context API rates below come from the official [OpenAI pricing
page](https://platform.openai.com/docs/pricing), retrieved 2026-08-29. They are kept in
[`config/openai-prices.standard.json`](../config/openai-prices.standard.json) as an explicit,
versioned input to local cost estimates; they are not a claim about ChatGPT subscription credits.

| Model           | Uncached input | Cached input | Cache write | Output |
| --------------- | -------------: | -----------: | ----------: | -----: |
| `gpt-5.6-sol`   |          $4.00 |        $0.40 |       $5.00 | $20.00 |
| `gpt-5.6-terra` |          $2.00 |        $0.20 |       $2.50 | $12.00 |
| `gpt-5.6-luna`  |          $0.20 |        $0.02 |       $0.25 |  $1.20 |

Rates are USD per one million tokens. The same page lists a separate long-context schedule (for
example, Sol $8/$0.80/$10/$30 for uncached/cached/cache-write/output). The runtime deliberately
does not silently select a schedule: configure the table that matches the actual provider,
context class, service tier, and model revision.

App Server `estimatedUsageUsdMicros` remains authoritative when it is present. A configured table
is only a fallback for providers that do not return dollar usage, and every benchmark record must
include the table digest when that fallback is used. Cache-write tokens are tracked separately so a
local estimate cannot undercount prompt-cache population.

```bash
AGENT_TRIO_PRICE_TABLE=$PWD/config/openai-prices.standard.json agent-trio benchmark observations.json
```

Re-check the official page before publishing a new benchmark report. Do not mix rates from different
context classes or providers in one paired comparison.
