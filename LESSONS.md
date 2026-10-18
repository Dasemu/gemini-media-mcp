# Lessons

Recurring mistakes and how to avoid them.

- The unit test suite (`npm test`) requires `PUBLIC_MEDIA_SIGNING_SECRET` (>=32 chars) to be set in the environment; without it, the "compact payload" test fails with `PUBLIC_MEDIA_SIGNING_SECRET must contain at least 32 characters`. Export a dummy value before running tests locally or in CI.
