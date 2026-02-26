# LLM Prompt Changelog

All notable changes to LLM prompt templates are documented here.

## Versioning Policy

- **MAJOR** version: Breaking changes to output schema
- **MINOR** version: Added fields, new guidelines
- **PATCH** version: Clarifications, typo fixes

All changes require regression test validation before deployment (P-21).

---

## [Unreleased]

*No unreleased changes*

---

## [1.0.0] - 2026-02-26

### Added

#### ambiguity-scoring-v1.0.0.md
- Initial ambiguity scoring prompt for market resolution criteria
- Risk factor categories: temporal, source reliability, semantic, scope, precedent
- Scoring guidelines: 0.0-1.0 scale with action recommendations
- Required JSON output format with cited passages

#### equivalence-assessment-v1.0.0.md
- Initial market equivalence assessment for cross-venue pairs
- Equivalence grades: identical, near_equivalent, similar_but_divergent, not_equivalent
- P-20 rubric compliance checklist
- Divergence risk assessment

#### resolution-analysis-v1.0.0.md
- Initial resolution rule analysis for headline-vs-rule mispricing
- Divergence types: scope, timing, definition, threshold
- Probability assessment with model_prob_yes/no/void
- Edge estimation guidelines

### Validation
- All prompts validated against initial gold corpus (10+ test cases each)
- Prompt injection tests passed (100% rejection rate)
- Structured output parsing verified

---

## Regression Test Requirements

Before deploying any prompt version change:

1. Run full regression suite against gold corpus
2. Compare scores to baseline (max delta < 0.15)
3. Verify correlation >= 0.85 with baseline
4. Confirm no rank order changes in top-3 markets
5. Run adversarial test suite (100% rejection required)
6. Document results in `llm_drift_sweeps` table

---

## Gold Corpus Categories

| Category | Count | Purpose |
|----------|-------|---------|
| standard | 20 | Normal market resolutions |
| edge_case | 10 | Contested/unusual outcomes |
| historically_disputed | 10 | Real markets with disputes |
| ambiguous_phrasing | 5 | Intentionally unclear criteria |
| prompt_injection | 5 | Adversarial input tests |

---

## Prompt Deployment Checklist

- [ ] Version number updated in prompt file
- [ ] CHANGELOG.md updated
- [ ] Regression tests pass (>= 90%)
- [ ] Adversarial tests pass (100%)
- [ ] Drift sweep completed
- [ ] No blocked_deployment flags
- [ ] Human review sign-off (if required)
