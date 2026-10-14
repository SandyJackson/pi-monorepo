# Design and maintainability

Judge the resulting code against documented repository standards and present requirements. Prefer removing complexity to relocating it. Apply the lean ladder in order:

1. Delete dead code, unused options and speculative features.
2. Reuse an existing implementation, naming its path and compatible contract.
3. Use the standard library or platform when it solves the same problem with fewer dependencies or concepts.
4. Apply YAGNI to abstractions, hooks and configuration with no present consumer.
5. Merge near-copies only when they represent the same concept and must change together.
6. Split unrelated responsibilities by reason to change, not by line count. A pass-through helper does not earn its indirection by shortening a function.

Count the concepts needed to follow a proposed refactor. Moving the same branches into more files is not a reduction. Premature abstraction is worse than duplication; show the concrete maintenance consequence before recommending either extraction or consolidation.

Use selected Fowler smells as labelled judgement calls, not hard violations:

- Possible mysterious name: a name hides the contract. Identify the misreading and suggest a clearer domain term.
- Possible feature envy: logic repeatedly reaches into another module's state. Consider moving it to the owner.
- Possible data clump or primitive obsession: travelling fields or ambiguous strings hide an invariant. A type earns its place only when it enforces that invariant.
- Possible repeated switches or shotgun surgery: one concept requires scattered synchronized changes. Consider gathering the decision in its owning module.
- Possible divergent change: one module changes for unrelated reasons. Consider splitting by responsibility.
- Possible speculative generality or middle man: unused extension points or delegation add concepts without behaviour. Prefer deletion.

Repository standards override these heuristics. Skip preferences already enforced by tooling. Finish with a specific present consequence and a simpler remedy for each candidate; apply the shared flag gate before reporting a smell as a finding.
