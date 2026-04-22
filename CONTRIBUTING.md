# Contributing

PRs welcome.

## Before submitting

- `npm test` (must stay green)
- `npm run build` (must succeed)
- `npm run lint` (must succeed)
- `CHANGELOG.md` updated under `[Unreleased]`

## Developer Certificate of Origin

Every commit carries a `Signed-off-by:` trailer — adding it (automatic with `git commit -s` or our prepare-commit-msg hook) certifies the [DCO 1.1](https://developercertificate.org/).

## Releases (maintainers only)

Releases are automated. To cut a release:

1. Open a release PR that bumps `package.json` and adds a new section to `CHANGELOG.md`
2. Merge the release PR
3. `git tag -s vX.Y.Z && git push origin vX.Y.Z`

The release workflow extracts the matching `CHANGELOG.md` section, creates the GitHub Release, signs `dist/index.js` with Sigstore, and publishes to npm with provenance.
