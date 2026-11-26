# DESIGN v1.3.7 — publish workflow stops reporting false-negative failures

Patch. No runtime code change: hardening of `.github/workflows/publish.yml` only.

## Problem (observed on the v1.3.6 release, 2026-11-18)

The tag-triggered publish run [44319472716] failed at `Publish to npm` with
`npm error code E409 … Cannot publish over previously staged version "1.3.6"`,
yet the registry ends up with exactly the CI-built tarball: registry `time`
shows the package created 14:06:24 (placeholder `0.0.0-stage`), the failing
PUT at 14:07:17, and 1.3.6 finalized at 14:08:01 with `dist-tags.latest`
pointing at it; shasum/integrity/fileCount match the run's own
`npm pack --dry-run` preview byte for byte.

Cause: npm publishes a brand-new package in two steps (PUT staged → POST
finalize). The first PUT landed server-side, its response was lost to a
network timeout, npm retried the PUT, and the registry answered 409 because
the version was already staged. The step exits 1; the registry finalizes the
publish ~45 s later. The red run is a client-side false negative.

## Decision

Keep `npm publish` as the primary path. On non-zero exit, probe
`https://registry.npmjs.org/<name>/<version>`; HTTP 200 means the publish
landed despite the client error → emit a `::warning::` and exit 0. Any other
probe result keeps the original exit code and adds an `::error::` naming the
observed HTTP status. The probe is existence-only (no shasum re-check): the
409-staged case is by construction our own PUT, and repacking the tarball to
compare adds a second pack for a guarantee we already preview via
`npm pack --dry-run`.

Rejected: raising npm `fetch-retries`/`fetch-timeout` tuning (does not fix
the staged-409 class, only its frequency); unpublishing the leftover
`0.0.0-stage` (single-version unpublish window is 72 h; it is a cosmetic
registry artifact of the staged flow).

## Tests

No JS surface change, so no new e2e section: `npm run check && npm test`
must stay green (142 checks, Node 20/22/24). The guard path itself is
shell logic exercised by the next real tag publish; the v1.3.6 incident is
the regression evidence.
