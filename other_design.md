# Other design notes

Notes on usage patterns and possible directions that are not part of the
documented surface in `README.md`.

## Curating what an anchor contains

An anchor inherits the path **root → anchor entry**, as raw session entries.
The simplest usage (read docs into the conversation, then `context_anchor
save`) lands the anchor at the end of that exploration, so every child gets
the raw exploration — including large file dumps you may not want to share.

You can curate what's in the prefix *before* saving, without any new code:
read the docs on one branch, branch back to an earlier point, write a
distilled brief, and save the anchor there. The anchor mechanism is
unchanged — it still inherits root → entry — you just choose an entry whose
path is the curated one.

```
Exploration branch (read raw; not inherited):
root → u1 → a1[read spec.json] → r1(raw) → a2[read skills] → r2(raw)
        │
        └─ branch from u1, write a brief ───────────────────────────┐
                                                                     ▼
Curated branch (what children inherit):
root
 └─ u1  "read the spec and skills"
    └─ aB  "## Project brief  (compact: spec points + skills + constraints)"
       └─ a3  [context_anchor save "brief"]
```

`anchorPointForSave` returns `aB` (the entry before the executing
`context_anchor save` turn). Children with `inherit_context: "brief"` get
`[u1, aB]` — only the request and the brief. They never see `r1`/`r2`.

This stays cache-friendly: `[u1, aB]` is a real root → node prefix that the
parent's server already processed, so it is a cache read, and every child
reusing `brief` shares it. No new code is needed — it is a usage pattern the
existing anchor plus Pi's branching already support.

### Why this is "kind 2" rather than arbitrary bundles

The cache-friendly unit is a *contiguous root → point prefix the parent
already sent*. Curating-by-branching keeps that invariant: the curated path
is still a real prefix in the tree, so it's a cache hit.

A different feature — letting the main agent cherry-pick an arbitrary
non-contiguous subset of messages (anchor A + anchor B, or an anchor plus an
extra message) — would break prefix caching (the server never saw that exact
sequence) and can produce malformed conversations (tool results without
their calls, assistant turns referencing removed context). That would be a
separate, explicitly cache-opt-out mode, not an extension of the anchor.

## Possible convenience: one-step curated anchor

The only new-code work that would help here is a convenience tool that does
"branch from entry X, write this brief, save anchor" in one step, so the
agent reliably produces curated cache-friendly prefixes instead of dumping
raw exploration into every subagent. Not implemented.
