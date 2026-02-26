# Paul P CLV Convention

**Version:** 1.0.0  
**Last Updated:** 2026-02-26

## Canonical Definition

For Paul P, Closing Line Value (CLV) is:

```text
CLV = closing_line_price - entry_price
```

This convention is system-wide and must not be inverted.

## Interpretation

- `CLV > 0`: favorable entry (edge)
- `CLV = 0`: neutral entry
- `CLV < 0`: unfavorable entry

## Reporting Units

- Decimal CLV: `[0,1]` price-space delta
- Cents CLV: `clv_cents = clv * 100`

## Side Handling

Prices are normalized into the same `P(YES)` basis before CLV comparison.  
If a venue reports NO-side economics directly, convert to YES-equivalent probability first.

## Closing Line Quality

Closing line inputs must include a quality score.  
If quality is below threshold (default `0.5`), set `clv_valid = 0` and exclude from score-sensitive evaluations.

## Examples

- Entry `0.42`, close `0.55` => `CLV = +0.13` (good entry)
- Entry `0.61`, close `0.57` => `CLV = -0.04` (poor entry)

## Sensitivity Requirement

Skill ranking reports must include stability checks with and without CLV influence.  
If top-rank order moves materially, mark CLV contribution as unstable for that run.
