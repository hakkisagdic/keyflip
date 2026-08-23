# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Architecture documentation (`docs/ARCHITECTURE.md`) with comprehensive module overview
- Turkish translations for architecture and labels documentation
- GitHub labels configuration (`docs/LABELS.md`) for project management
- TypeScript type-checking via JSDoc annotations and `tsc --noEmit`

### Changed
- Migrated entire codebase from CommonJS to ES Modules
- CHANGELOG.md now follows Keep a Changelog format with comparison links
- CI pipeline includes lint, format check, and type-check steps

### Infrastructure
- ESLint configuration for code quality enforcement
- Prettier for consistent code formatting
- Husky and lint-staged for pre-commit hooks
- `.nvmrc` for consistent Node.js version across contributors

## [1.5.2] - 2025-07-14

### Added
- Initial changelog tracking begins at this version.
- Developer tooling: ESLint, Prettier, Husky, lint-staged.
- Test coverage script via Node.js built-in coverage.

[Unreleased]: https://github.com/hakkisagdic/keyflip/compare/v1.5.2...HEAD
[1.5.2]: https://github.com/hakkisagdic/keyflip/releases/tag/v1.5.2
