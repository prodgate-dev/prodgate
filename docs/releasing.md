# Releasing

Prodgate publishes to npm and cuts a GitHub release from CI when a `v*.*.*` tag is
pushed (see `.github/workflows/release.yml`). The tag must match the `version` in
`package.json`.

## One-time setup

- Create an npm automation token for the `prodgate` package and add it as the
  `NPM_TOKEN` repository secret. The release workflow uses it for `npm publish`, and
  publishes with provenance (the workflow has `id-token: write`).

## Cutting a release

1. Make sure `package.json` `version` is the version you intend to publish, and that
   `main` is green (`npm run typecheck`, `npm test`, `npm run build:action` clean).
2. Tag the exact commit and push it:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   The Release workflow verifies the tag matches the package version, runs the checks,
   publishes to npm, and creates the GitHub release.
3. Verify: `npm view prodgate version` and `npx prodgate@1.0.0 --version`.
4. Move the rolling major tag only after the exact version is verified, so
   `uses: prodgate-dev/prodgate@v1` resolves to it:
   ```bash
   git tag -f v1 v1.0.0
   git push -f origin v1
   ```
5. Test `uses: prodgate-dev/prodgate@v1` in a clean external repository (a plan that
   deletes a database should fail the check; adding the `prodgate-approved` label in
   the labeling event should pass it).

## Deprecating the pre-pivot package

The `0.x` versions on npm are the previous, unrelated product. After `1.0.0` is
published, deprecate them (requires `npm login` as the package owner):

```bash
npm deprecate prodgate@"<1.0.0" "prodgate 1.0 is a new tool: a Terraform and OpenTofu destructive-change CI gate. See the README."
```
