# Changelog

Notable changes to Lavish Library are recorded here. Releases follow [Semantic Versioning](https://semver.org/).

## [0.3.1](https://github.com/jazz127/lavish-library/compare/v0.3.0...v0.3.1) (2026-09-01)


### Bug Fixes

* add branded favicon ([#5](https://github.com/jazz127/lavish-library/issues/5)) ([ad68198](https://github.com/jazz127/lavish-library/commit/ad68198058ea039022395191156a67ec68ca4d24))

## [0.3.0](https://github.com/jazz127/lavish-library/compare/v0.2.0...v0.3.0) (2026-09-01)


### Bug Fixes

* harden local library release boundary ([3d4ecd0](https://github.com/jazz127/lavish-library/commit/3d4ecd02a29e7b9930066621a9a15555516ed4fc))
* **library:** scope status counts to project ([a61e148](https://github.com/jazz127/lavish-library/commit/a61e14859c7e0fe52afc659fbc94160ece9013c0))
* **nav:** group insights pages ([10ac506](https://github.com/jazz127/lavish-library/commit/10ac50653dc9d8e3528111ce1d71fd1d2d03e906))
* **release:** preserve v-prefixed tags ([a6e82a3](https://github.com/jazz127/lavish-library/commit/a6e82a32a156f8083c7d962c663401e14c3ae43e))
* **release:** preserve v-prefixed tags ([8db5178](https://github.com/jazz127/lavish-library/commit/8db5178c42bbcdb0fb1e472cbf1fa4b9e0dd4e5c))
* **security:** harden local API boundary ([07d15ca](https://github.com/jazz127/lavish-library/commit/07d15ca14be062ff5b5ca070810eb2d7d75427e8))
* **security:** restrict local trust scope ([f9a1ef2](https://github.com/jazz127/lavish-library/commit/f9a1ef2af3ef04506f25cd8a31387a7dc07635fd))


### Miscellaneous Chores

* release 0.3.0 ([bde10d2](https://github.com/jazz127/lavish-library/commit/bde10d27f518a8c3b5848ce1bcbf0373d0317a6c))

## [0.2.0](https://github.com/jazz127/lavish-library/compare/v0.1.0...v0.2.0) (2026-09-01)

### Features

- Added the Signal Observatory for local usage evidence, recurring topics, searches, artifact shapes, and plan evolution.
- Added Lavish Review with recommendations, dormant work, template candidates, and quick value and outcome feedback.
- Added local analytics that deliberately excludes foreground-time tracking and distinguishes recorded evidence from unknown history.

### Improvements

- Split Observatory and Review into direct navigation destinations under Insights.
- Scoped library status totals correctly when filtering by project.

## [0.1.0](https://github.com/jazz127/lavish-library/releases/tag/v0.1.0) (2026-09-01)

### Features

- Added a local-first browser library that discovers central Lavish sessions and project `.lavish` artifacts.
- Added search, project and status filters, sorting, grid and list views, reopening, and Finder reveal actions.
- Added protected version archives with content-addressed snapshots, local assets, timelines, comparisons, and safe restore.
