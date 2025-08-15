# DEB-0001: Add MCP Request Parameter to All API Calls

## Ticket ID
DEB-0001-mcp-request-parameter

## Summary
Add 'mcp_request' = true parameter to all backend API calls to enable MCP-specific decision making

## Priority
P1 - High Priority

## Component
services

## Issue Type
enhancement

## Description
The backend needs to distinguish between requests coming from the MCP server versus other clients to make MCP-specific decisions and optimizations. All API calls from the MCP server should include a `mcp_request: true` parameter.

**Expected Behavior:**
- All service calls (E2esService and BrowserSessionsService) include `mcp_request: true` parameter
- Backend can identify and handle MCP requests differently
- Parameter is consistently applied across all endpoints

**Current Behavior:**
- No MCP identification parameter is sent with requests
- Backend cannot differentiate MCP requests from other client requests

## Acceptance Criteria
- [ ] Add `mcp_request: true` to all E2esService API calls
- [ ] Add `mcp_request: true` to all BrowserSessionsService API calls  
- [ ] Update AxiosTransport to automatically include MCP parameter
- [ ] Verify parameter is sent in request body/headers for all endpoints
- [ ] Test that existing functionality remains unaffected

## Technical Details
**Files Affected:**
- `services/e2es.ts` - All API method calls
- `services/browserSessions.ts` - All API method calls
- `utils/axiosTransport.ts` - Automatic parameter injection
- `types/index.ts` - Type definitions if needed

**Implementation Approach:**
1. Modify AxiosTransport to automatically include `mcp_request: true` in all requests
2. Alternatively, update each service method to include the parameter
3. Ensure parameter is properly formatted for different request types (GET, POST, etc.)

## Investigation Notes
- Review current API call patterns in services/e2es.ts and services/browserSessions.ts
- Determine best approach: automatic injection vs manual inclusion
- Consider request method differences (query params vs body params)

## Status
open

## Assignee
backend-architect

## Created
2025-01-15

## Updated
2025-01-15