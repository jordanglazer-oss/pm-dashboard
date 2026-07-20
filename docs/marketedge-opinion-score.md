# MarketEdge Opinion Score — reference

Source: MarketEdge's own "Opinion Score: a measurement of market risk" help
dialog (PM-provided screenshot, 2026-07-18). This is the authoritative
interpretation behind `marketEdge.opinion` / `marketEdge.opinionScore` on the
Stock type and the early-warning logic in `app/lib/external-scoring.ts`.

The Opinion Score measures how far the technical condition has moved SINCE the
current opinion was issued — a trajectory signal layered on top of the opinion.
The scale direction FLIPS between the two sides:

## Longs (score runs 0 → −4, deterioration)

| Label        | Score | Meaning / market risk |
|--------------|-------|-----------------------|
| Long         | 0     | Stock is a buy. Market risk low. |
| Long         | −1    | Buy with minor deterioration. Risk low. |
| Long         | −2    | Technical deterioration underway. Risk moderate but increasing. |
| Long/Neutral | −3    | **Warning sign if you own it.** Significant deterioration — start evaluating Buy-Hold-Sell. Risk significantly increasing. |
| Long/Neutral | −4    | **Warning sign if you own it.** Extreme deterioration. Risk high. |

## Avoids (score runs 0 → +4, improvement)

| Label         | Score | Meaning / market risk |
|---------------|-------|-----------------------|
| Avoid         | 0     | Stock is an Avoid. Risk high for buyers. |
| Avoid         | +1    | Avoid with minor improvement. Risk still high. |
| Avoid         | +2    | Technical improvement underway. Risk moderate, decreasing. |
| Avoid/Neutral | +3    | **Warning if short.** Significant improvement — start evaluating strategies. Risk significantly decreasing. |
| Avoid/Neutral | +4    | **Warning if short.** Extreme improvement. Risk low for buyers — but not as low as a Long at 0. |

## Dashboard implications

- `marketEdgeWarning()` thresholds (Long ≤ −3 → "Technicals deteriorating";
  Avoid ≥ +3 → "Reversal watch") map exactly to MarketEdge's own warning rows.
- **Hybrid labels:** at ±3/±4 MarketEdge's opinion column reads "Long/Neutral"
  / "Avoid/Neutral". The CSV parser prefix-matches these to `long` / `avoid` —
  they are still Long/Avoid opinions, and they're precisely the rows the
  early-warning flag exists for. (Exact matching here was a silent-miss bug,
  fixed 2026-07-18.)
- The Opinion Score is a TRAJECTORY signal only — it never feeds the composite
  `marketEdge` category score (0–2), which is driven by the Power Rating
  (≥ +60 → 2, −27…+59 → 1, < −27 → 0).
- An Avoid at +4 is NOT equivalent to a Long at 0 (MarketEdge says so
  explicitly) — don't collapse the two sides into one linear scale.
