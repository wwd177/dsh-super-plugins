# Incremental handoff compression

Use the previous verified handoff plus messages since its last boundary. First extract the delta: new requirements, changed files, decisions, checks, cancellations and remaining work. Merge entries by file path or decision identity; replace superseded status explicitly, retaining a necessary reason for the change. Do not repeatedly summarize the old summary in full.

Protect exact paths, function names, IDs, error codes, numeric values and units. Keep “not tested”, “failed”, “paused”, “do not delete”, and conditional permissions distinct from success or approval. Historical intent is evidence, not fresh authorization. A cancelled objective stays cancelled until the user resumes it.

Use a short source boundary such as the last completed phase or latest message ID when available. A handoff can point to full logs, but its next action must be usable without reading every log. Do not store raw reasoning, secrets or the full conversation. Save or update a file only under the entrypoint's existing save authorization.

Check the resulting note with continuation questions: What is the current goal? Which exact files matter? What remains unverified? What must not happen? What is the next authorized action? If an answer requires guessing, restore the source detail. For a disputed or stale fact, read its original source instead of preserving a plausible summary.

Track checkpoint duration, input size and recovery reads when benchmarking. Fewer tokens that cause repeated re-exploration are not a win. Do not install arbitrary 70–80% trigger thresholds or change model/runtime compaction settings from this guidance.

Source: [context-compression](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering/tree/9ff0c99108b36d3b886defd825d8ac1f47dba374/skills/context-compression), MIT. Adapted strategy; no upstream demonstration evaluator copied. This is a human-readable continuation workflow, not an opaque context engine.
