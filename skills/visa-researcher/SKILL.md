---
name: visa-researcher
description: Researches all available visa and residence permit types for a given country, returning structured data with requirements, fees, and application process.
---

# Visa Researcher

## Instructions

When activated, research every individual visa and residence permit type available for the specified country.

1. **Search official sources** — use the country's immigration authority website and reputable immigration law firms as primary sources.
2. **List every subcategory separately** — never group multiple visa types into a single entry. If a country has numbered or lettered visa codes (e.g., D1, D2, E1, E2), list each one individually.
3. **Cover all categories** from the checklist in `references/visa-categories.md`.
4. **Verify completeness** — after initial research, do a second search specifically for uncommon, recently introduced, or country-specific visa programs you may have missed.
5. **Return structured JSON** — output only a valid JSON array, no markdown or explanation.

## Output Format

Return a JSON array where each object has:

```json
{
  "name": "Visa name",
  "code": "Official code if any, otherwise null",
  "category": "One of: short-stay, long-stay, work, self-employment, investment, student, research, family, digital-nomad, startup, retirement, humanitarian, religious, medical, youth-exchange, seasonal, intra-company-transfer, other",
  "purpose": "What this visa is for",
  "duration": "How long it lasts",
  "key_requirements": ["requirement 1", "requirement 2"],
  "fees": "Cost breakdown",
  "issuing_authority": "Which government body issues it",
  "notes": "Any important caveats or recent changes"
}
```

## References

- See `references/visa-categories.md` for the complete category checklist to ensure no visa type is missed.
