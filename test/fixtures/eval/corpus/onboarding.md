# Engineering Onboarding

## Runtime

The command-line projects require Node.js 20 or newer. Install dependencies with Bun, then run typecheck, tests, and build before opening a pull request.

## Local verification

Use mocked provider boundaries in the default test suite. Real provider and vector-database integration tests are opt-in and require `INTEGRATION=1`.
