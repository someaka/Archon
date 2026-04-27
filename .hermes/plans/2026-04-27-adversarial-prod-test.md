# Adversarial Production Test Plan

> First live test of the polished Hermes provider code.

## Steps

### Step 1: Build for production

```bash
cd /home/d/Desktop/Archon-canonical
bun run build
```

### Step 2: Start Web UI (prod, port 3090)

```bash
PORT=3090 bun run start
```

Verify: health check at http://localhost:3090/api/health

### Step 3: Run adversarial workflow

Use hermes-pr-verifier workflow against the working tree changes.
The workflow runs 3 parallel reviewers (code quality, security, protocol)
with an adversarial evaluator scoring every finding.

```bash
bun run cli workflow run hermes-pr-verifier "Adversarial verification of Hermes provider polish pass — 11 files changed, 167 tests, covering silent failures, JSON-RPC error handling, test coverage, and code quality improvements"
```

### Step 4: Report results

Read the verdict and report to user.
