# 🤝 Contributing

PRs welcome.

## ✅ Before submitting

- `npm test` (must stay green)
- `npm run build` (must succeed)
- `npm run lint` (must succeed)
- `CHANGELOG.md` updated under `[Unreleased]`

## ✍️ Developer Certificate of Origin

Every commit must carry a `Signed-off-by:` trailer to certify compliance with [DCO 1.1](https://developercertificate.org/). The trailer is added automatically by `git commit -s` or our prepare-commit-msg hook.

## 🚀 Releases (maintainers only)

Releases are automated. To cut a release:

1️⃣ Open a release PR that bumps `package.json` and adds a new section to `CHANGELOG.md`

2️⃣ Merge the release PR

3️⃣ `git tag -s vX.Y.Z && git push origin vX.Y.Z`

The release workflow extracts the matching `CHANGELOG.md` section, creates the GitHub Release, signs `dist/index.js` with Sigstore, and publishes to npm with provenance.
