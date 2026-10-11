---
name: local-knowledge-save
description: Save explicitly requested information or a verified reusable bug fix when current user authorization and the host memory policy allow it. Choose scope and recall policy, deduplicate the write, and verify it; read-only tasks and keyword hints do not authorize saving.
---

# Local Knowledge save

Follow the current user request and host memory policy first. Neither this skill nor a hook hint expands permission to write. Do not save when the user requests read-only work, postpones changes, or asks not to remember. If the host requires an explicit user request for every memory write, the automatic-save condition below does not apply. Without authorization, finish the main task and do not repeatedly ask about an optional save.

When writing is permitted, save only in these cases:

1. The user explicitly says to remember, save, use as a future default, or record a preference.
2. The host permits automatic knowledge capture, and an error's root cause and fix have been verified by an actual build, test, or run and are reusable.
3. The user confirms a fact, decision, or stable workflow should be retained long term.

Do not save guesses, intermediate diagnostic states, or one-off noise. Never store plaintext credentials such as passwords, access tokens, API keys, private keys, or cookies. `confidential` content must use `manual`; imported content cannot be `pinned`.

"Save the file," a quoted "remember," and "the build passed" are not explicit requests to save knowledge. The last phrase is not verification evidence by itself. Write only to this plugin's knowledge database, without copying into other host memory directories.

## Modeling

- `preference`: user preference. Use `global + pinned` for a stable cross-project preference, or `on_match` when it matters only to a specific topic.
- `bug`: only a verified reusable fix, normally `on_match`. Choose scope by whether the knowledge transfers across projects, not by the directory where the failure occurred.
- `fact`: a fact the user asks to save or a verified project fact, normally `on_match`.
- `decision`: a settled choice and its constraints, normally `on_match`.
- `workflow`: a repeatable procedure, normally `on_match`.
- `note`: an explicit note that fits none of the above; use `manual` if it should not appear automatically.

Choose scope by the true reuse boundary: use `global` for knowledge that transfers across projects, and `workspace` or `repository` only for knowledge specific to one. Use a stable semantic name for `canonical-key`; put terms likely to occur in future questions in `cues`, not noisy paragraphs.

Use `authority=user_asserted` for a user's statement, `verified_local` for locally verified technical facts or fixes, and `imported` for external imports. Record verification conditions and date for version, path, platform, and tool-availability claims. Save time is not verification time.

## Bug record criteria

Before recording a bug, decide whether its root cause, conditions, and direct fix can be reused outside the current project:

- For a general bug, use `global + on_match`. Keep only reusable symptoms, stable error identifiers, conditions, actual root cause, direct fix, and verification steps in the title, body, `cues`, and `tags`. Remove project, repository, branch, commit, customer, and business names; absolute paths, temporary log values, and narrative diagnostic history. Retain an item only when it is a general technical condition necessary to identify the root cause.
- Use `repository` or `workspace` only if the cause or fix materially depends on that repository's code, configuration, protocol, or data conventions and is likely to recur there. Retain only the minimum project context needed to diagnose and fix it.

The root cause must explain the mechanism that produces the symptom. Vague statements such as "configuration issue," "it worked after a change," or "this project needs it disabled" are insufficient. Do not record guesses that have not been confirmed by a build, test, or run.

For example, if a compilation error stems from a generally incompatible toolchain artifact, record the fix as `global + on_match` when it does not depend on repository implementation. Use project scope only if the fix must change repository-specific configuration or protocol conventions.

## Save

```text
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json remember --kind <bug|preference|fact|note|decision|workflow> --title "<short title>" --content "<complete knowledge>" --cues "<cue1>,<cue2>" --tags "<tag1>,<tag2>" --canonical-key "<stable key>" --scope-kind <global|workspace|repository> --scope-key "<scope identifier>" --recall-policy <pinned|on_match|manual> --authority <user_asserted|verified_local|imported> --sensitivity <normal|confidential>
```

`<plugin-root>` is the plugin directory containing this skill (two levels above this `SKILL.md`). Leave `scope-key` empty for global scope; use the current absolute path for workspace or repository scope.

The same scope, kind, and `canonical-key` identify one record. Only identical persistent fields return `operation=unchanged`; changes to body, cues, policy, or sensitivity return `operation=updated` and increment `revision`. On revision, omitted title, cues, tags, recall policy, authority, and sensitivity retain their old values; an explicit empty string clears the title, cues, or tags. Check the existing record and scope, then update only changed fields rather than creating near duplicates.

## Verify

Immediately after saving, query with a realistic future question:

```text
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json recall --read-only --query "<future query>" --scope-kind <scope> --scope-key "<scope identifier>" --occasion prompt --limit 5
```

Verify automatic recall for `on_match` and `pinned` with the ordinary prompt query above. Do not use `--explicit` to hide an incorrect recall policy. Use `--explicit` only for `manual` or `confidential` records. Confirm the returned `id`, `kind`, `scope_kind`, `scope_key`, `recall_policy`, and body. If recall fails, report the index, scope, policy, or cue issue; a successful write alone is not full success.
