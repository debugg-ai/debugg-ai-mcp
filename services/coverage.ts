// services/issues.ts
import { CoverageResponse } from "./types.js";
import { AxiosTransport } from "../utils/axiosTransport.js";


export interface CoverageService {
    createCoverage(fileContents: Uint8Array, filePath: string, repoName: string, branchName: string, params?: Record<string, any>): Promise<CoverageResponse | null>;
    logFailedRun(fileContents: Uint8Array, filePath: string, repoName: string, branchName: string, params?: Record<string, any>): Promise<CoverageResponse | null>;
    getCoverage(filePath: string, repoName: string, branchName: string, params?: Record<string, any>): Promise<CoverageResponse | null>;
}


export const createCoverageService = (tx: AxiosTransport): CoverageService => ({
    /**
     * Create a test coverage file for a given file
     */
    async createCoverage(
        fileContents: Uint8Array,
        filePath: string,
        repoName: string,
        branchName: string,
        params?: Record<string, any>
    ): Promise<CoverageResponse | null> {
        try {
            const serverUrl = "api/v1/coverage/";
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
            console.error("GET_COVERAGE: Full path - ", filePath, ". Relative path - ", relativePath);
            const fileParams = {
                ...params,
                fileContents: fileContents,
                absPath: filePath,
                filePath: relativePath,
                repoName: repoName,
                branchName: branchName,
            };
            const response = await tx.post<CoverageResponse>(serverUrl, { ...fileParams });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error fetching issues in file:", err);
            return null;
        }
    },

    /**
     * Log a failed run for a given test file
     */
    async logFailedRun(
        fileContents: Uint8Array,
        filePath: string,
        repoName: string,
        branchName: string,
        params?: Record<string, any>
    ): Promise<CoverageResponse | null> {
        try {
            const serverUrl = "api/v1/coverage/log_failed_run/";
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
            console.error("GET_COVERAGE: Full path - ", filePath, ". Relative path - ", relativePath);
            const fileParams = {
                ...params,
                fileContents: fileContents,
                absPath: filePath,
                filePath: relativePath,
                repoName: repoName,
                branchName: branchName,
            };
            const response = await tx.post<CoverageResponse>(serverUrl, { ...fileParams });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error fetching issues in file:", err);
            return null;
        }
    },

    /**
     * Get a test coverage file for a given file
     */
    async getCoverage(
        filePath: string,
        repoName: string,
        branchName: string,
        params?: Record<string, any>
    ): Promise<CoverageResponse | null> {

        try {
            const serverUrl = "api/v1/coverage/for_file/";
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
            console.error("GET_COVERAGE: Full path - ", filePath, ". Relative path - ", relativePath);
            const fileParams = {
                ...params,
                filePath: relativePath,
                absPath: filePath,
                repoName: repoName,
                branchName: branchName,
            };
            const response = await tx.get<CoverageResponse>(serverUrl, { ...fileParams });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error fetching issues in file:", err);
            return null;
        }

    }
});
