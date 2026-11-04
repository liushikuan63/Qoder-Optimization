# Change Safety Protocol

Apply before any code or configuration change in a mini program project.

## Before editing

- Read the current file and its callers; confirm the change is necessary.
- Keep the diff minimal and limited to the requested behavior.
- Check that no secret, token, certificate, or private endpoint is added to source.
- Identify a rollback point (version control, backup, or feature flag).

## Before committing

- Run the project's relevant build and tests.
- Review the diff for unrelated edits and generated files.
- Confirm configuration changes are documented and reversible.
- Do not bypass review or tests to make a deadline.

## When uncertain

- Stop and ask for the missing requirement or credential.
- Do not guess platform limits, review rules, or production data.
- Record the uncertainty and the chosen rollback path.
