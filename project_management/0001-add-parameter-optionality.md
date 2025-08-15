# 0001: Add Parameter Optionality and URL Intelligence

## CEO Requests Overview

1. **Add 'mcp_request' = true param to all api calls** to our backend so it can make MCP specific decisions
2. **Ensure the new session endpoints & functionality work properly** 
3. **Let MCP provide default relative URLs** for a given question:
   - *"I changed the projects list page code, check that the table data loads still"*
   - Go straight to where we want to see. Eg `/projects/1234/`

---

## Project Scope & Implementation Plan

### **Phase 1: Core Infrastructure (P1 - High Priority)**

#### 1.1 MCP Request Parameter Integration
**Goal**: Enable backend to distinguish MCP requests from other clients
- **Component**: Services Layer (`services/`, `utils/axiosTransport.ts`)
- **Agent**: `backend-architect`
- **Deliverable**: All API calls include `mcp_request: true` parameter
- **JIRA**: `DEB-0001-mcp-request-parameter`

#### 1.2 Session Endpoints Validation  
**Goal**: Comprehensive validation of browser session functionality
- **Component**: Services & Handlers (`services/browserSessions.ts`, `handlers/liveSessionHandlers.ts`)
- **Agent**: `debug-specialist`
- **Deliverable**: Fully tested and validated session management system
- **JIRA**: `DEB-0002-session-endpoints-validation`

#### 1.3 URL Intelligence System
**Goal**: Intelligent URL routing based on natural language descriptions
- **Component**: Tools & AI Logic (`tools/testPageChanges.ts`, new `utils/urlResolver.ts`)
- **Agent**: `ai-engineer`
- **Deliverable**: Natural language to URL mapping system
- **JIRA**: `DEB-0003-default-relative-urls`

### **Phase 2: Integration & Enhancement (P2 - Medium Priority)**

#### 2.1 Live Session URL Intelligence
**Goal**: Extend URL intelligence to live browser sessions
- **Component**: Live Session Tools (`tools/liveSession.ts`)
- **Agent**: `ai-engineer`
- **Deliverable**: Intelligent navigation in live sessions
- **JIRA**: `DEB-0004-url-intelligence-integration`

#### 2.2 Transport Layer Optimization
**Goal**: Enhanced AxiosTransport with automatic parameter injection
- **Component**: Utilities (`utils/axiosTransport.ts`)
- **Agent**: `backend-architect`
- **Deliverable**: Optimized transport with auto MCP parameters
- **JIRA**: `DEB-0005-transport-optimization`

### **Phase 3: Quality Assurance (P2-P3)**

#### 3.1 Comprehensive Testing
**Goal**: Full test coverage for all new features
- **Component**: Testing Framework (`__tests__/`)
- **Agent**: `frontend-testing-expert`
- **Deliverable**: Complete test suite with integration tests
- **JIRA**: `DEB-0006-comprehensive-testing`

#### 3.2 Documentation Update
**Goal**: Updated documentation reflecting new capabilities
- **Component**: Documentation (`README.md`, `CLAUDE.md`)
- **Agent**: `product-spec-writer`
- **Deliverable**: Comprehensive feature documentation
- **JIRA**: `DEB-0007-documentation-update`

---

## Agent Assignments & Responsibilities

### **backend-architect** (Lead: Infrastructure)
- **Primary**: DEB-0001 (MCP Parameters), DEB-0005 (Transport Optimization)
- **Mission**: Backend integration and API optimization
- **Success Criteria**: All API calls include MCP parameters, optimized transport layer

### **debug-specialist** (Lead: Validation)
- **Primary**: DEB-0002 (Session Validation)
- **Mission**: Comprehensive testing and validation of session endpoints
- **Success Criteria**: All session functionality validated and working correctly

### **ai-engineer** (Lead: Intelligence)
- **Primary**: DEB-0003 (URL Intelligence), DEB-0004 (Live Session Integration)
- **Mission**: Natural language processing and intelligent URL routing
- **Success Criteria**: Context-aware URL generation from natural language

### **frontend-testing-expert** (Lead: Quality)
- **Primary**: DEB-0006 (Testing)
- **Mission**: Comprehensive test coverage for all new features
- **Success Criteria**: >90% test coverage, all integration tests passing

### **product-spec-writer** (Lead: Documentation)
- **Primary**: DEB-0007 (Documentation)
- **Mission**: Feature documentation and usage guides
- **Success Criteria**: Complete documentation with examples and best practices

---

## Technical Architecture

### **URL Intelligence Engine**
```typescript
interface URLResolver {
  resolveFromDescription(description: string): string[];
  getDefaultURL(pageType: string): string;
  generateParameterizedURL(pattern: string, params: Record<string, any>): string;
}
```

**Pattern Matching Examples:**
- *"projects list page"* → `/projects/`
- *"user profile functionality"* → `/profile/`, `/users/{id}/`
- *"dashboard loads correctly"* → `/dashboard/`, `/`

### **MCP Parameter Integration**
```typescript
// Automatic injection via AxiosTransport
const transport = new AxiosTransport({
  baseUrl: serverUrl,
  apiKey: apiKey,
  defaultParams: { mcp_request: true }
});
```

### **Session Enhancement**
- Real-time monitoring capabilities
- Enhanced error handling and logging
- Improved state management and transitions

---

## Acceptance Criteria

### **Phase 1 (P1 - Critical)**
- [ ] All API calls include `mcp_request: true` parameter
- [ ] Session endpoints fully validated and working
- [ ] URL intelligence system operational with basic patterns
- [ ] Natural language descriptions resolve to appropriate URLs

### **Phase 2 (P2 - Important)**  
- [ ] Live sessions support intelligent URL navigation
- [ ] Transport layer optimized with automatic parameter handling
- [ ] Error handling improved with MCP-compatible responses

### **Phase 3 (P2-P3 - Quality)**
- [ ] Comprehensive test suite with >90% coverage
- [ ] Integration tests for all new functionality
- [ ] Documentation updated with examples and guides
- [ ] Performance benchmarks established

---

## Success Metrics

### **Technical Excellence**
- Zero critical bugs in new functionality
- All tests passing with comprehensive coverage
- <200ms response time for URL resolution
- Successful MCP parameter injection on 100% of API calls

### **User Experience**
- Natural language URL resolution accuracy >95%
- Session management reliability >99.9%
- Clear error messages and debugging information
- Seamless integration with existing workflows

### **Business Impact**
- Reduced time to set up tests by 60%+
- Improved AI context understanding for better test results
- Enhanced backend decision-making capabilities
- Streamlined development workflow for testing

---

## Dependencies & Risks

### **Critical Dependencies**
- Backend API support for `mcp_request` parameter
- Stable session management endpoints
- TypeScript compilation without errors

### **Risk Mitigation**
- Comprehensive testing before deployment
- Backward compatibility maintained
- Rollback plan for transport layer changes
- Performance monitoring for new features

---

## Timeline Estimate

- **Phase 1**: 3-4 days (P1 tickets)
- **Phase 2**: 2-3 days (P2 tickets) 
- **Phase 3**: 2-3 days (Testing & Documentation)
- **Total**: 7-10 days end-to-end

**Critical Path**: DEB-0001 → DEB-0002 → DEB-0003 → Integration Testing