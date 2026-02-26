# Paul P Market Pairing Guide

**Version:** 1.0.0  
**Last Updated:** 2026-02-26

## Purpose

Market pairing enables cross-venue strategy logic only when two markets are sufficiently equivalent under strict controls.

## Pairing Prerequisites

- Canonical event mapping completed
- Resolution criteria available for both venues
- Settlement windows comparable
- Void/cancellation rules reviewed

## Equivalence Grades

- `identical`: same effective resolution rules and timing
- `near_equivalent`: minor language differences, same effective semantics
- `similar_but_divergent`: related event but non-trivial rule mismatch
- `not_equivalent`: unsafe for shared signal logic

Execution is permitted only for `identical` and `near_equivalent`.

## Workflow

1. Discovery: collect candidate overlaps.
2. Deterministic checks: canonicalization + hard mismatch rules.
3. LLM assessment: structured equivalence reasoning with citations.
4. Human review: approve/reject pair before activation.
5. Ongoing validation: expire stale or invalidated pairs.

## Human Review Requirements

- Reviewer must record decision, timestamp, and rationale.
- Rejections must include concise mismatch reason.
- Any post-approval rule-source changes require re-review.

## Audit Requirements

- Store LLM run IDs and cited passages.
- Record all approvals/rejections in audit trail.
- Retain raw rule texts and source evidence hashes.

## Operational Endpoints

- `/find-pairs`
- `/propose-pair`
- `/approve-pair`
- `/reject-pair`
- `/expire-pairs`
