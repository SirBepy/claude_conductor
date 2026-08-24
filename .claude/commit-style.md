# Commit style overrides

## Folding

Never ask whether to fold a new commit into a peer session's unpushed commit
when `/commit`'s unpushed-overlap check finds an adjacent-line hit (e.g. two
sessions each adding an import line next to each other). Default straight to
keeping commits separate, no question. Joe does not use commit folding in
this project.
