# Deployment Runbook

## Canary rollout

Production releases begin with a five percent canary. Hold the canary for fifteen minutes while checking error rate, p95 latency, and saturation.

## Automatic rollback

Roll back when the canary error rate exceeds two percent for three consecutive minutes. The rollback restores the previous immutable image; it does not rebuild from the moving branch head.

## Routine rotation

The release captain rotates weekly. This staffing rotation is unrelated to credential or encryption-key rotation.
