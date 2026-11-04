# Deployment Gate

Complete every check before uploading or publishing a mini program.

## Required checks

- Build succeeds with the project's official toolchain.
- Relevant tests pass; failures are understood and not waived silently.
- Version, environment, and distribution channel are correct.
- Permissions and privacy declarations match the features being shipped.
- No test account, mock endpoint, or debug switch is left enabled.
- A rollback plan exists and the previous published version is known.

## Before pressing publish

- Confirm the upload was verified in a test or trial environment.
- Confirm the release owner has explicitly approved publication.
- Never publish on the user's behalf without a direct instruction.
- If any check is unknown or unavailable, stop and report it as unverified.
