// services/issues.ts
import { E2eRun, E2eTest, E2eTestSuite, PaginatedResponse } from "./types.js";
import { AxiosTransport } from "../utils/axiosTransport.js";


export interface E2esService {
    createE2eTest(description: string, params?: Record<string, any>): Promise<E2eTest | null>;
    runE2eTest(uuid: string, params?: Record<string, any>): Promise<E2eTest | null>;
    createE2eRun(fileContents: Uint8Array, filePath: string, repoName: string, branchName: string, params?: Record<string, any>): Promise<E2eRun | null>;
    getE2eRun(uuid: string, params?: Record<string, any>): Promise<E2eRun | null>;
    listE2eTests(params?: Record<string, any>): Promise<PaginatedResponse<E2eTest> | null>;
    getE2eTest(uuid: string, params?: Record<string, any>): Promise<E2eTest | null>;
    deleteE2eTest(uuid: string): Promise<void>;
    formatRunResult(e2eRun: E2eRun): string;

    createE2eTestSuite(description: string, params?: Record<string, any>): Promise<E2eTestSuite | null>;
    listE2eTestSuites(params?: Record<string, any>): Promise<PaginatedResponse<E2eTestSuite> | null>;
    getE2eTestSuite(uuid: string, params?: Record<string, any>): Promise<E2eTestSuite | null>;
    runE2eTestSuite(uuid: string, params?: Record<string, any>): Promise<E2eTestSuite | null>;
}

const paramsToBody = (params: Record<string, any>) => {
    const filePath = params?.filePath;
    const repoName = params?.repoName;
    const branchName = params?.branchName;
    let relativePath = params?.filePath;
    // Convert absolute path to relative path
    if (params?.repoPath) {
        relativePath = filePath?.replace(params?.repoPath + "/", "");
    } else {
        console.error("No repo path found for file");
        // split based on the repo name
        const repoBaseName = repoName?.split("/")[-1] ?? "";  // typically the form of 'userName/repoName'
        const splitPath = filePath?.split(repoBaseName) ?? [];
        if (splitPath?.length === 2) {  // if the repo name is in the path & only once, otherwise unclear how to handle
            relativePath = splitPath[1] ?? filePath;
        } else {
            relativePath = filePath ?? "";
        }
    }
    const body = {
        ...params,
        absPath: filePath ?? "",
        filePath: relativePath ?? "",
        repoName: repoName ?? "",
        branchName: branchName ?? "",
    };
    console.error("Body params - ", body);
    return body;
};


export const createE2esService = (tx: AxiosTransport): E2esService => ({
    /**
     * Create a test coverage file for a given file
     */
    async createE2eTest(
        description: string,
        params?: Record<string, any>
    ): Promise<E2eTest | null> {
        try {
            const serverUrl = "api/v1/e2e-tests/";
            // console.error('Branch name - ', branchName, ' repo name - ', repoName, ' repo path - ', params?.repoPath);

            // let relativePath = filePath;
            // // Convert absolute path to relative path
            // if (params?.repoPath) {
            //     relativePath = filePath.replace(params?.repoPath + "/", "");
            // } else {
            //     console.error("No repo path found for file");
            //     // split based on the repo name
            //     const repoBaseName = repoName.split("/")[-1];  // typically the form of 'userName/repoName'
            //     const splitPath = filePath.split(repoBaseName);
            //     if (splitPath.length === 2) {  // if the repo name is in the path & only once, otherwise unclear how to handle
            //         relativePath = splitPath[1];
            //     } else {
            //         relativePath = filePath;
            //     }
            // }
            // console.error("CREATE_E2E_TEST: Full path - ", filePath, ". Relative path - ", relativePath);
            // const fileParams = {
            //     ...params,
            //     description: description,
            //     absPath: filePath,
            //     filePath: relativePath,
            //     repoName: repoName,
            //     branchName: branchName,
            // };
            const response = await tx.post<E2eTest>(serverUrl, { description, ...params });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error creating E2E test:", err);
            return null;
        }
    },
    /**
     * Create a test coverage file for a given file
     */
    async runE2eTest(
        uuid: string,
        params?: Record<string, any>
    ): Promise<E2eTest | null> {
        try {
            const serverUrl = `api/v1/e2e-tests/${uuid}/run/`;
            const response = await tx.post<E2eTest>(serverUrl, { ...params });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error running E2E test:", err);
            return null;
        }
    },

    async createE2eRun(
        fileContents: Uint8Array,
        filePath: string,
        repoName: string,
        branchName: string,
        params?: Record<string, any>
    ): Promise<E2eRun | null> {
        try {
            const serverUrl = "api/v1/e2e-runs/";
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
            console.error("CREATE_E2E_TEST: Full path - ", filePath, ". Relative path - ", relativePath);
            const fileParams = {
                ...params,
                fileContents: fileContents,
                absPath: filePath,
                filePath: relativePath,
                repoName: repoName,
                branchName: branchName,
            };
            const response = await tx.post<E2eRun>(serverUrl, { ...fileParams });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error creating E2E test:", err);
            return null;
        }
    },
    /**
     * Get a E2E run for a given UUID
     */
    async getE2eRun(
        uuid: string,
        params?: Record<string, any>
    ): Promise<E2eRun | null> {

        try {
            const serverUrl = `api/v1/e2e-runs/${uuid}/`;
            const response = await tx.get<E2eRun>(serverUrl, { ...params });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error fetching E2E run:", err);
            return null;
        }

    },

    /**
     * Get a E2E test for a given UUID
     */
    async getE2eTest(
        uuid: string,
        params?: Record<string, any>
    ): Promise<E2eTest | null> {

        try {
            const serverUrl = `api/v1/e2e-tests/${uuid}/`;
            const response = await tx.get<E2eTest>(serverUrl, { ...params });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error fetching E2E test:", err);
            return null;
        }

    },
    /**
     * Delete a E2E test for a given UUID
     */
    async deleteE2eTest(
        uuid: string,
        params?: Record<string, any>
    ): Promise<void> {
        try {
            const serverUrl = `api/v1/e2e-tests/${uuid}/`;
            await tx.delete(serverUrl, { ...params });
        } catch (err) {
            console.error("Error deleting E2E test:", err);
        }
    },
    /**
     * List E2E tests
     */
    async listE2eTests(
        params?: Record<string, any>
    ): Promise<PaginatedResponse<E2eTest> | null> {

        try {
            const serverUrl = `api/v1/e2e-tests/`;
            const response = await tx.get<PaginatedResponse<E2eTest>>(serverUrl, { ...params });

            console.error("Raw API response:", response);
            return response;

        } catch (err) {
            console.error("Error listing E2E tests:", err);
            return null;
        }

    },
    async createE2eTestSuite(
        description: string,
        params?: Record<string, any>
    ): Promise<E2eTestSuite | null> {
        try {
            const serverUrl = "api/v1/test-suites/generate_tests/";
            const body = paramsToBody({...params, description});
            const response = await tx.post<E2eTestSuite>(serverUrl, { ...body });
            console.error("Raw API response:", response);
            return response;
        } catch (err) {
            console.error("Error creating E2E test suite:", err);
            return null;
        }

    },
    async listE2eTestSuites(params?: Record<string, any>): Promise<PaginatedResponse<E2eTestSuite> | null> {
        try {
            const serverUrl = "api/v1/test-suites/";
            const response = await tx.get<PaginatedResponse<E2eTestSuite>>(serverUrl, { ...params });
            console.error("Raw API response:", response);
            return response;
        } catch (err) {
            console.error("Error listing E2E test suites:", err);
            return null;
        }
    },
    async getE2eTestSuite(
        uuid: string,
        params?: Record<string, any>
    ): Promise<E2eTestSuite | null> {   
        try {
            const serverUrl = `api/v1/test-suites/${uuid}/`;
            const response = await tx.get<E2eTestSuite>(serverUrl, { ...params });
            console.error("Raw API response:", response);
            return response;
        } catch (err) {
            console.error("Error fetching E2E test suite:", err);
            return null;
        }
    },
    async runE2eTestSuite(
        uuid: string,
        params?: Record<string, any>
    ): Promise<E2eTestSuite | null> {
        try {
            const serverUrl = `api/v1/test-suites/${uuid}/run/`;
            const response = await tx.post<E2eTestSuite>(serverUrl, { ...params });
            console.error("Raw API response:", response);
            return response;
        } catch (err) {
            console.error("Error running E2E test suite:", err);
            return null;
        }
    },
    formatRunResult(result: E2eRun): string {
        if (!result) return 'No result data available.';
        // const failureOutput = failures.map(f => 
        //     `❌ **${f.testName}**\n> ${f.message}\n${f.location ? `Location: ${f.location}` : ''}`
        // ).join('\n\n');
        const duration = new Date().getTime() - new Date(result.timestamp).getTime();
        return `
    🧪 Test Name: ${result.test?.name}
    🧪 Test Description: ${result.test?.description}
    ⏱ Duration: ${duration}ms
    ✅ Passed: ${result.status === 'completed' && result.outcome === 'pass'}
    ${result.status === 'completed' && result.outcome !== 'pass' ? `\n### Failures:\n${result.outcome}` : ''}
    `.trim();
    }
});
