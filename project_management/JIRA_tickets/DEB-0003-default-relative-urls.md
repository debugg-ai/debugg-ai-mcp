# DEB-0003: Implement Default Relative URL Routing

## Ticket ID
DEB-0003-default-relative-urls

## Summary
Enable MCP to provide default relative URLs for test scenarios based on natural language context

## Priority
P1 - High Priority

## Component
tools

## Issue Type
feature

## Description
Implement intelligent URL routing that allows the MCP server to automatically determine appropriate relative URLs based on natural language test descriptions. This enables users to say "check that the table data loads" and have the system automatically navigate to relevant pages like `/projects/1234/`.

**Expected Behavior:**
- Parse natural language descriptions to extract URL hints
- Map common phrases to relative URL patterns
- Provide default URLs when specific pages aren't explicitly mentioned
- Support parameterized URLs with intelligent defaults

**Example Use Cases:**
- "I changed the projects list page code, check that the table data loads still" → `/projects/`
- "Test the user profile functionality" → `/profile/` or `/users/123/`
- "Verify the dashboard loads correctly" → `/dashboard/`

## Acceptance Criteria
- [ ] Create URL pattern matching system for common page types
- [ ] Implement natural language processing for URL extraction
- [ ] Add default URL configuration for common application sections
- [ ] Support parameterized URLs with sample data
- [ ] Integrate with existing test page changes tool
- [ ] Add configuration for custom URL patterns
- [ ] Document URL pattern matching rules

## Technical Details
**Files Affected:**
- `tools/testPageChanges.ts` - Add URL intelligence
- `handlers/testPageChangesHandler.ts` - URL processing logic
- `types/index.ts` - New URL configuration types
- `config/index.ts` - Default URL patterns
- New file: `utils/urlResolver.ts` - URL intelligence engine

**Implementation Approach:**
1. Create URL pattern dictionary for common page types
2. Implement text analysis to extract page context
3. Add fallback URL generation with parameters
4. Integrate with existing test description processing

**URL Pattern Examples:**
```json
{
  "projects": ["/projects/", "/projects/{id}/"],
  "users": ["/users/", "/profile/", "/users/{id}/"],
  "dashboard": ["/", "/dashboard/", "/home/"],
  "login": ["/login/", "/auth/login/"],
  "settings": ["/settings/", "/config/"]
}
```

## Investigation Notes
- Analyze common test descriptions from user feedback
- Research NLP libraries for JavaScript/TypeScript
- Consider integration with existing project analysis tools
- Design extensible pattern matching system

## Status
open

## Assignee
ai-engineer

## Created
2025-01-15

## Updated
2025-01-15