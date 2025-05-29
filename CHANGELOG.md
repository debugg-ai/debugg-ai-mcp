# Changelog

All notable changes to the DebuggAI MCP project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).



## [1.0.7] - 2025-05-29

### Fixed
- Fixed tunneling issues
- Remove notifications when a token is not provided in the original request

## [1.0.2] - 2025-05-28

### Fixed
- Fixed ES module path resolution issues
- Added proper shebang line to executable files
- Ensured executable permissions are set during build

### Added
- Docker container support
- Improved error handling for E2E test runs

## [1.0.1] - 2025-05-28

### Fixed
- Fixed TypeScript configuration to target ES2022
- Resolved dependency issues with Zod library

### Added
- Initial implementation of E2E test runner
- Integration with DebuggAI server client

## [1.0.0] - 2025-05-28

### Added
- Initial release of DebuggAI MCP
- Support for running UI tests via MCP protocol
- Integration with ngrok for tunnel creation
- Basic test reporting functionality 