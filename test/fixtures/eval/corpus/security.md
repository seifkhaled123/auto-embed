# Security Operations

## Credential rotation

Production API keys rotate every ninety days. Emergency rotation begins immediately after suspected exposure, and the previous key is revoked only after dependent services confirm the replacement.

## Logging

Never log an API key, bearer token, database password, or unredacted authorization header. Diagnostic output may include the provider name and a masked suffix.

## Access reviews

Repository administrator access is reviewed quarterly. This access-review schedule does not replace the ninety-day credential rotation policy.
