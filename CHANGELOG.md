# Changelog

All notable changes to the DebuggAI MCP project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.15] - 2025-08-18

### Added
- **Live Session Monitoring Tools**: Added 5 new MCP tools for real-time browser session monitoring
  - `debugg_ai_start_live_session`: Launch live remote browser sessions with real-time monitoring
  - `debugg_ai_stop_live_session`: Stop active live sessions
  - `debugg_ai_get_live_session_status`: Monitor session status and health
  - `debugg_ai_get_live_session_logs`: Retrieve console logs and network requests from live sessions
  - `debugg_ai_get_live_session_screenshot`: Capture screenshots from active sessions
- **Enhanced Tunnel Management**: Complete rewrite of tunnel infrastructure with improved ngrok integration
  - New `TunnelManager` service for high-level tunnel abstraction
  - Automatic localhost URL detection and tunnel creation
  - Better error handling and connection stability
  - Integrated tunnel support in live session handlers
- **Browser Sessions Service**: New dedicated service for managing browser automation sessions
- **Comprehensive Test Infrastructure**: Added extensive test suite covering unit, integration, and end-to-end scenarios
  - Handler tests for E2E suites and live sessions
  - Backend services integration tests
  - Network and MCP tools validation tests
  - Mock infrastructure for reliable testing
- **Enhanced Project Analysis**: New utilities for analyzing codebases and extracting context
- **Improved Error Handling**: Centralized error management with structured error types
- **URL Parser Utilities**: Robust URL parsing and localhost detection capabilities
- **Configuration Management**: Centralized configuration system with environment-based settings
- **API Specification**: Complete OpenAPI specification for backend integration
- **GitHub Actions Workflows**: Automated publishing, version bumping, and validation workflows

### Changed
- **Major Architecture Refactoring**: Reorganized services, handlers, and utilities into cleaner modular structure
- **Moved Tunnel Services**: Relocated tunnel management from `tunnels/` to `services/ngrok/` for better organization
- **Enhanced E2E Runner**: Improved test execution with better progress tracking and error handling
- **Updated Package Dependencies**: Upgraded to latest versions of core dependencies including MCP SDK
- **Improved Documentation**: Updated README with comprehensive setup and usage instructions
- **Enhanced Type Definitions**: Expanded type system with better validation schemas

### Fixed
- **API Endpoint Updates**: Resolved compatibility issues with backend API changes
- **Image Support Improvements**: Enhanced handling of screenshots and visual test artifacts
- **Tunnel Connection Stability**: Fixed issues with ngrok tunnel reliability and reconnection
- **ES Module Compatibility**: Resolved module resolution issues for better Node.js compatibility

### Security
- **License Addition**: Added Apache 2.0 license for proper open source compliance
- **Environment Variable Validation**: Enhanced validation of sensitive configuration data

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