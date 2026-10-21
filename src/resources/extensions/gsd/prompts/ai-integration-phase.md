You are running the GSD **ai-integration-phase** workflow — produce an AI design contract (AI-SPEC) for a milestone/slice that builds an AI system.

## Target

{{target}}

## Process

1. **Load intent.** Read the milestone/slice goal and requirements for the AI capability.

2. **Define the AI capability contract:**
   - **Inputs:** what the model receives (schema, context, examples) and any preprocessing.
   - **Outputs:** the expected response shape, how it's parsed/validated, and how failures are handled.
   - **Model & parameters:** which model/provider, temperature, max tokens, fallback chain — never hardcode; reference config.
   - **Prompt/contract:** the system/user prompt strategy, or tool/function calling schema.
   - **Evaluation:** how quality is measured (eval set, rubric, human-in-the-loop checkpoints).
   - **Cost & latency budget:** expected per-call cost and latency, and the ceiling that triggers a redesign.

3. **Risk register.** Hallucination/grounding, prompt injection, data leakage, cost runaway, model deprecation. For each, the mitigation.

4. **Write the AI-SPEC** to the milestone/slice artifact in `.gsd/`. Recommend `/gsd plan-phase` or `/gsd spike` for high-uncertainty model behaviors.

## Success criteria

- Inputs/outputs are schema-defined, not prose-only.
- Evaluation is concrete (eval set + rubric), not "it looks good".
- Cost/latency has a budget and a ceiling.
- The risk register covers the standard AI failure modes.
