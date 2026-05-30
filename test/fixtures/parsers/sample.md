# Onboarding Handbook

Welcome to the team. This document is the canonical reference for getting started.

## Setup

Before your first day, install the standard toolchain and verify access to shared infrastructure.

### Toolchain

You will need Node 18 or newer, Bun, and Git.

```bash
node --version
bun --version
git --version
```

### Access

Request access to the following systems on day one:

- the staging cluster
- the observability dashboard
- the on-call rotation calendar

## Working norms

We default to async communication. Meetings exist for decisions, not status.

### Code review

All code lands behind a pull request with at least one approval. Self-merges are reserved for documentation typos.

### Incidents

If a system page fires during your on-call shift, acknowledge within five minutes and write a short note in the incident channel.

## Resources

A short list of links worth bookmarking on your first week:

- the runbook for the production database
- the architecture diagram
- the postmortem archive
