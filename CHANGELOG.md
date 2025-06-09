# Changelog

All notable changes to the DebuggAI MCP project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.14] - 2025-06-09

### Added
- Final screen shot included.

## [1.0.12] - 2025-06-02

### Added
- Readme docs issue

## [1.0.11] - 2025-06-02

### Added
- New readme with instructions on install, usage, etc.

## [1.0.10] - 2025-05-29

### Fixed
- Most MCP clients still don't support images. removed that as a response.


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