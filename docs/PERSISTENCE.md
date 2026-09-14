# Graph persistence (M4.5)

The primary store is a versioned JSON sidecar beside the saved AE project:
`<project>.aep.comp-<composition ID>.ntl`. Move this file with the project.
Each composition has a separate graph document. Layer comments remain identity
tags; they do not store layout or topology.

The document preserves the complete graph, graph ID, project path, composition
ID, schema version, save timestamp, and last observed reconciled AE baseline.
Schema 1 is the first supported format. Unknown versions are refused; there is
no legacy schema to migrate yet.

Graph commands save changes, including layout and expression edits. Save Graph
also saves explicitly. Saving writes a temporary file before replacing the
destination and retains the previous valid document as `.bak`. A corrupt main
file can load the backup; the panel requires review before editing resumes.
Save failures remain visible in the footer.

After each successful patch, the panel reads AE again and saves the resulting
baseline together with the graph and native IDs. This does not depend on an
idle poll. New layers receive their graph label and stack position in the
creation undo group, preventing leftover label/order changes on reopen.

Startup loads the document before reading AE, checks project/comp identity,
compares its graph with current AE, and compares the recorded baseline with AE.
Differences require an explicit review. Startup never applies a saved graph
automatically. Without a sidecar, comp hydration remains a recovery path.

On reopen, unique comment tags refresh cached native layer IDs. Duplicate tags
still require review. Property comparison tolerates small magnitude-dependent
rounding differences observed in AE saves (for example, 669.33332824707 becoming
669.333312988281); meaningful position changes still produce a conflict. A clean
reopen saves the refreshed IDs and baseline without writing to the composition.

Current limitations: save the AE project before enabling persistence, then
reopen the panel. Save As / project relocation requires moving the sidecar and
an explicit identity migration (not yet implemented). Canvas viewport is not
currently modeled. Disk operations use CEP's Node filesystem runtime.

Automated tests cover graph round-trip, unsupported versions, interrupted
replacement, and backup recovery. The close-AE/reopen-project acceptance matrix
still needs a real host run; M4.5 is not yet acceptance-verified.
