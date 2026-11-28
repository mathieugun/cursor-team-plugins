# Fix the conflict check for untracked files

From `requests/02-review.md`: a failed diff can look like a clean conflict check. When untracked local files exist,
`checkConflicts` asks Git which paths changed upstream and compares those names with the untracked paths. Empty output
on failure clears this part of the check, and trimming the output removes a leading space from the first filename.
Follow `changedPaths` by checking the exit code and requesting untrimmed output for the NUL-delimited list. Cover a
failed diff and a first filename with a leading space.
