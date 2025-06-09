// services/issues.ts
import { AxiosResponse, Issue, IssueSuggestion, PaginatedIssueResponse, PaginatedIssueSuggestionResponse } from "./types.js";
import { AxiosTransport } from "../utils/axiosTransport.js";


export interface IssuesService {
  getIssues(page?: number): Promise<PaginatedIssueResponse>;
  getAlertLevelIssues(projectKey: string): Promise<Issue[]>;
  getIssuesForProject(projectKey: string, level?: string, page?: number, additionalParams?: Record<string, any>): Promise<PaginatedIssueResponse>;
  getIssuesInFile(filePath: string, repoName: string, branchName: string, params?: Record<string, any>): Promise<Issue[]>;
  getRecentIssues(params?: Record<string, any>): Promise<Issue[]>;
  createIssue(issue: Partial<Issue>): Promise<Issue>;
  getIssue(uuid: string): Promise<Issue>;
  updateIssue(uuid: string, issue: Partial<Issue>): Promise<Issue>;
  getIssueLogs(uuid: string): Promise<Issue>;
  resolveIssue(uuid: string, data: Partial<Issue>): Promise<Issue>;
  getIssueSuggestions(companyKey: string, projectKey: string, options?: { page?: number; queryParams?: Record<string, any> }): Promise<PaginatedIssueSuggestionResponse>;
  getIssueSuggestion(companyKey: string, projectKey: string, id: number): Promise<IssueSuggestion>;
}


export const createIssuesService = (tx: AxiosTransport): IssuesService => ({
  /**
   * Get a paginated list of issues
   */
  async getIssues(page?: number): Promise<PaginatedIssueResponse> {
    const params = page ? { page } : undefined;
    const response = await tx.get<PaginatedIssueResponse>("/api/v1/issues/", { params });
    return response;
  },

  /**
   * Get a paginated list of Alert Level issues which are essentially just very recent
   * and high priority issues that have been logged locally during development.
   */
  async getAlertLevelIssues(projectKey: string): Promise<Issue[]> {

    const issues = await this.getIssuesForProject(projectKey, "error", 1);
    const alertLevelIssues = issues.results.filter((issue: Issue) => issue.priority === "alert");
    return alertLevelIssues;
  },
  /**
   * Get a paginated list of issues for a project
   */
  async getIssuesForProject(projectKey: string, level?: string, page?: number, additionalParams?: Record<string, any>): Promise<PaginatedIssueResponse> {
    const params = {
      ...(level ? { level } : {}),
      ...(page ? { page } : {}),
      ...(additionalParams || {}),
    };
    const response = await tx.get<PaginatedIssueResponse>(`/api/v1/issues/project/${projectKey}/`, { params });
    return response;
  },

  async getIssuesInFile(
    filePath: string,
    repoName: string,
    branchName: string,
    params?: Record<string, any>
  ): Promise<Issue[]> {

    try {
      const serverUrl = "api/v1/suggestions/for_project/";
      console.error('Branch name - ', branchName, ' repo name - ', repoName, ' repo path - ', params?.repoPath);

      let relativePath = filePath;
      // Convert absolute path to relative path
      if (params?.repoPath) {
        relativePath = filePath.replace(params?.repoPath + "/", "");
      } else {
        console.error("No repo path found for file");
        // split based on the repo name
        const repoBaseName = repoName.split("/")[-1];  // typically the form of 'userName/repoName'
        const splitPath = filePath.split(repoBaseName);
        if (splitPath.length === 2) {  // if the repo name is in the path & only once, otherwise unclear how to handle
          relativePath = splitPath[1];
        } else {
          relativePath = filePath;
        }
      }
      console.error("GET_ISSUES_IN_FILE: Full path - ", filePath, ". Relative path - ", relativePath);
      const fileParams = {
        ...params,
        filePath: relativePath,
        repoName: repoName,
        branchName: branchName,
      };
      const response = await tx.get<PaginatedIssueResponse>(serverUrl, {...fileParams});

      // console.error("Raw API response:", response);

      // Optionally filter suggestions that match the current file
      // (If your backend already filters by file_path, this might be unnecessary,
      //  but it's often safer to double-check.)
      const issues = response.results as Issue[];
      return issues;

    } catch (err) {
      console.error("Error fetching issues in file:", err);
      return [];
    }

  },
  async getRecentIssues(params?: Record<string, any>): Promise<Issue[]> {
    const response = await tx.get<PaginatedIssueResponse>("/api/v1/issues/recent_local/", params);
    return response.results as Issue[];
  },
  /**
   * Create a new issue
   */
  async createIssue(issue: Partial<Issue>): Promise<Issue> {
    const response = await tx.post<AxiosResponse<Issue>>("/api/v1/issues/", issue);
    return response.data;
  },

  /**
   * Get a specific issue by UUID
   */
  async getIssue(uuid: string): Promise<Issue> {
    const response = await tx.get<AxiosResponse<Issue>>(`/api/v1/issues/${uuid}/`);
    return response.data;
  },

  /**
   * Update an issue
   */
  async updateIssue(uuid: string, issue: Partial<Issue>): Promise<Issue> {
    const response = await tx.put<AxiosResponse<Issue>>(`/api/v1/issues/${uuid}/`, issue);
    return response.data;
  },

  /**
   * Get logs for an issue
   */
  async getIssueLogs(uuid: string): Promise<Issue> {
    const response = await tx.get<AxiosResponse<Issue>>(`/api/v1/issues/${uuid}/logs/`);
    return response.data;
  },

  /**
   * Resolve an issue
   */
  async resolveIssue(uuid: string, data: Partial<Issue>): Promise<Issue> {
    const response = await tx.post<AxiosResponse<Issue>>(`/api/v1/issues/${uuid}/resolve/`, data);
    return response.data;
  },

  /**
   * Get suggestions for a project's issues
   * @param companyKey Company identifier
   * @param projectKey Project identifier
   * @param options Optional parameters including page number and additional query params
   */
  async getIssueSuggestions(
    companyKey: string,
    projectKey: string,
    options?: { page?: number; queryParams?: Record<string, any> }
  ): Promise<PaginatedIssueSuggestionResponse> {
    const params = {
      ...(options?.page ? { page: options.page } : {}),
      ...(options?.queryParams || {})
    };
    const response = await tx.get<PaginatedIssueSuggestionResponse>(
      `/api/v1/suggestions/${companyKey}/${projectKey}/`,
      { params }
    );
    return response;
  },

  /**
   * Get a specific issue suggestion
   */
  async getIssueSuggestion(
    companyKey: string,
    projectKey: string,
    id: number
  ): Promise<IssueSuggestion> {
    const response = await tx.get<AxiosResponse<IssueSuggestion>>(
      `/api/v1/suggestions/${companyKey}/${projectKey}/${id}/`
    );
    return response.data as IssueSuggestion;
  }
});
