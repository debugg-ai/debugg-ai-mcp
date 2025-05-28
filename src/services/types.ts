import { AxiosRequestConfig } from "axios";


export interface PaginatedResponse<T> {
    count: number;
    next: string | null;
    previous: string | null;
    results: T[];
}

export interface AxiosResponse<T> {
    data: T;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    config: AxiosRequestConfig;
}

export interface Message {
    uuid: string;
    sender: string;
    role: string;
    content: string;
    cleanedTickedContent: string | null;
    jsonContent: Record<string, any> | null;
    timestamp: string;
    lastMod: string;
}

export interface Conversation {
    uuid: string;
    creatorUuid: string;
    user: number;
    company: number;
    messages: Message[];
    timestamp: string;
    lastMod: string;
}

export interface Issue {
    uuid: string;
    project: number;
    title?: string;
    message?: string;
    environment: string;
    status: "open" | "ongoing" | "resolved" | "archived";
    level: Level;
    priority: "low" | "medium" | "high" | "alert";
    codeSingleLine: string | undefined;
    lineNumber: number;
    columnNumber: number;
    eventsCount: number;
    filePath: string;
    firstSeen: string;
    lastSeen: string;
    tags?: Record<string, any>;
    participants: number[];
    timestamp: string;
    lastMod: string;
    overview: LogOverview;
    solution?: IssueSolution;
    suggestions?: IssueSuggestion[];
}

/**
 * Snippet update for a file change
 */
export interface SnippetUpdate {
    startLine: number; // 1-indexed
    endLine: number; // 1-indexed
    newContent: string;
    prevContent: string;
}

/**
 * File change for an issue solution
 */
export interface FileChange {
    filePath: string;
    snippetsToUpdate: SnippetUpdate[];
}

/**
 * Fix for an issue
 */
export interface IssueSolution {
    uuid: string;
    changes: FileChange[];
}
/**
 * Issue suggestion
 */
export interface IssueSuggestion {
    filePath: string;
    errorCount: number;
    lineNumber: string;
    columnNumber: string;
    message: string;
}

/**
 * Paginated response for issues
 */
export interface PaginatedIssueResponse extends PaginatedResponse<Issue> {
}

/**
 * Paginated response for issue suggestions
 */
export interface PaginatedIssueSuggestionResponse extends PaginatedResponse<IssueSuggestion> {
}


export type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "FATAL" | "METRIC";


export interface LogOverview {
    title: string;
    message: string;
    args: unknown[];                       // e.g. ['foo', 'bar']
    kwargs: Record<string, unknown>;       // e.g. { baz: 'qux' }
    stackTrace: string | null;             // e.g. "File "backend/transactions/tasks.py", line 10, in <module>\n    raise Exception('test')\nException: test"

    exceptionType?: string | null;        // e.g. "AttributeError"
    handled?: string | null;               // e.g. "no"
    mechanism?: string | null;             // e.g. "celery"
    environment?: string | null;           // e.g. "production"
    traceId?: string | null;              // e.g. "6318bd31dbf843b48380bbfe3979233b"
    celeryTaskId?: string | null;        // e.g. "396bf247-f397-4ef3-a0b7-b9d77a803ed2"
    runtimeVersion?: string | null;       // e.g. "3.11.5"
    serverName?: string | null;           // e.g. "ip-10-0-1-25.us-east-2.compute.internal"
    eventId?: string | null;             // e.g. "fda64423"
    timestamp?: string | null;             // e.g. "2023-03-10T06:20:21.000Z"
    level?: Level | null;                 // e.g. "error", "warning"
    filePath?: string | null;             // e.g. "backend/transactions/tasks.py"
    messagePreview?: string | null;       // e.g. "AttributeError: 'NoneType' object..."
}


// TODO: Remove this
export interface FileResult {
    uuid: string;
    company: number;
    level: Level | null;
    title: string;
    message: string | null;
    lineNumber: number | null;
    columnNumber: number | null;
    errorCount: number;
    suggestions: Array<{
        lineNumber: number;
        message: string;
        filePath: string;
        errorCount: number;
    }>;
    overview: LogOverview;
}

export interface CoverageResponse {
    uuid: string;
    company: string;
    filePath: string;
    repoName: string;
    branchName: string;
    testFilePath: string;
    testFileContent: string;
    coverage: null;
    timestamp: string;
    lastMod: string;
}

export interface E2eTest {
    id: string;
    uuid: string;
    timeStamp: string;
    lastModified: string;
    project: number;
    curRun?: E2eRun | null;
    host?: number | null;
    name: string;
    description?: string | null;
    agent?: number | null;
    agentTaskDescription?: string | null;
    testScript: string; // path or URL
    createdBy?: number | null;
}

export type E2eRunStatus = 'pending' | 'running' | 'completed';
export type E2eRunOutcome = 'pending' | 'skipped' | 'unknown' | 'pass' | 'fail';
export type E2eRunType = 'generate' | 'run';

export interface E2eRunMetrics {
  executionTime: number;
  numSteps: number;
}


export interface E2eRun {
  id: number;
  uuid: string;
  timestamp: string;
  lastModified: string;
  key: string;
  runType: E2eRunType;
  test?: E2eTest | null;
  status: E2eRunStatus;
  outcome: E2eRunOutcome;
  conversations?: Conversation[]; // array of Conversations
  startedBy?: number | null;
  runOnHost?: number | null;
  targetUrl?: string | null;
  runGif?: string | null;  // Url to the gif file containing the run
  runJson?: string | null;  // Url to the json file containing the run data
  metrics?: E2eRunMetrics | null;
}
