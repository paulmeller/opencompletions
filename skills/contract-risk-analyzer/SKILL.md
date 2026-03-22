---
name: contract-risk-analyzer
description: Analyzes contract documents clause by clause and produces a structured risk assessment with per-clause ratings.
---

# Contract Risk Analyzer

## Instructions

When activated, analyze the provided contract document using the following process:

1. **Read the contract** in its entirety before beginning analysis.
2. **Identify each clause** or section of the contract.
3. **Evaluate each clause** against the risk rubric in `references/risk-rubric.md`.
4. **Assign a risk rating** (High, Medium, or Low) to each clause with a brief justification.
5. **Write the output** as a structured markdown file.

## Output Format

Write your assessment to `risk-assessment.md` using this structure:

```markdown
# Contract Risk Assessment

## Summary
- **Document**: [name of the contract]
- **Overall Risk**: [High/Medium/Low]
- **High Risk Clauses**: [count]
- **Medium Risk Clauses**: [count]
- **Low Risk Clauses**: [count]

## Clause Analysis

### [Clause Name/Number]
- **Risk Level**: [High/Medium/Low]
- **Summary**: [one-line description of the clause]
- **Concern**: [explanation of the risk]
- **Recommendation**: [suggested revision or mitigation]

(repeat for each clause)

## Recommendations
[Overall recommendations for contract negotiation]
```

## References

- See `references/risk-rubric.md` for the scoring criteria used to rate each clause.
