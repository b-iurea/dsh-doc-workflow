# DESIGN v1.3.6 — publish on npm (issue #1)

Infra release: the plugin moves from a local-only bundle (`@local/doc-workflow`, `private: true`) to a public npm package, so any DSH instance can install the exact same bundle the market catalog lists. No flow-logic changes.

## 1 Rename

`@local/doc-workflow` → `dsh-doc-workflow` (unscoped — npm forbids `_` in scopes, so a scoped name could never match the GitHub handle). Sites: `package.json` `name`, `cordis.patch.yml` `name:` row, `client.js` module id + `TAB_ID` (the sidebar tab key is the package name: after an upgrade the tab simply re-registers under the new key — `.doc-workflow/` state folders on disk are keyed by workspace, not by package name, so nothing moves). `package.json` also gains `license: MIT` + `repository`/`homepage`/`bugs` (parity with other published DSH bundles) and loses `private`.

## 2 Publish pipeline

`.github/workflows/publish.yml` triggers only on tags `v*`:

1. **version guard** — `GITHUB_REF_NAME` minus `v` must equal `package.json` `version`; a mismatched tag fails loudly and publishes nothing (protects against mis-tagged releases reaching npm),
2. `npm run check` + `npm test` on the Node 20 floor,
3. `npm pack --dry-run` (the `files` allow-list is the shipped surface: `index.js`, `client.js`, `cordis.patch.yml`, `locale/*.json`, `icon.svg` + npm-forced README/LICENSE/package.json — no tests, no DESIGN docs),
4. `npm publish --access public` authenticated by the repo secret `NPM_TOKEN` — a granular token held only by the owner; agents never see it.

The trigger chain stays the workspace release rule: **merge → annotated tag → GitHub Release → npm publish**, one tag firing the last step. Deferred upgrade: npm OIDC trusted publishing (tokenless) becomes possible once the package exists; then `NPM_TOKEN` retires.

## 3 Install surface

README: npm install (`plugin_manager install_bundle dsh-doc-workflow`, market Discover) + profile patch row + migration note (disable a leftover `@local/doc-workflow` entry so two tabs don't register). The awesome-dsh-plugin catalog entry (`data/plugins/b-iurea__dsh-doc-workflow.yml`) now resolves against a real npm version.
