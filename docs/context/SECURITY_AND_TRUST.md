# Security and Trust Model

## Credentials

- Encrypt and store on the backend.
- Never return credentials to the frontend.
- Store credential/connection references in workflows, never secrets.

## Permission levels

- Read
- Reversible write
- External communication
- Destructive
- Unknown

## Confirmation

Approval must be tied to the workflow run, node, loop iteration, operation, argument hash, and expiry. If the actual action changes, ask again.

## Browser safety

- Isolated per-run browser context.
- Restricted network and session lifetime.
- Download/upload limits and secret redaction.
- Confirmation before submission, purchase, upload, deletion, or external messages.

## Audit

Record actor, workflow, node, action, timestamp, result, and redacted argument summary.
