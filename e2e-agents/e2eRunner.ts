// src/E2eTestRunner.ts
import { DebuggAIServerClient } from '../services/index.js';
import { E2eRun } from '../services/types.js';
// Remove dependency on problematic ngrok wrapper
import { RunResultFormatter } from './resultsFormatter.js';
import { fetchAndOpenGif } from './recordingHandler.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';

// Use createRequire to avoid ES module resolution issues
const require = createRequire(import.meta.url);
let ngrokModule: any = null;

async function getNgrok() {
    if (!ngrokModule) {
        try {
            ngrokModule = require('ngrok');
        } catch (error) {
            throw new Error(`Failed to load ngrok module: ${error}`);
        }
    }
    return ngrokModule;
}

// test-runner.ts
export interface FailureDetail {
    testName: string;
    message: string;
    location?: any;
}

export interface RunResult {
    filePath: string;
    ok: boolean;                 // true = all passed
    durationMs?: number;         // if you have it
    failures: FailureDetail[];   // empty when ok === true
    stdout: string;              // raw runner output
    stderr: string;
}

export type StepAction = {
    input_text: {
        index: number;
        text: string;
    } | {
        click_element_by_index: {
            index: number;
        };
    };
};

export interface StepMessageContent {
    currentState: {
        evaluationPreviousGoal: string;
        memory: string;
        nextGoal: string;
    };
    action: StepAction[];
}

async function startTunnel(authToken: string, localPort: number, domain: string) {
    try {
        const ngrok = await getNgrok();
        
        if (process.env.DOCKER_CONTAINER === "true") {
            const url = await ngrok.connect({ proto: 'http', addr: `host.docker.internal:${localPort}`, hostname: domain, authtoken: authToken });
            return url;
        } else {
            const url = await ngrok.connect({ proto: 'http', addr: localPort, hostname: domain, authtoken: authToken });
            return url;
        }
    } catch (err) {
        console.error('Error starting ngrok tunnel:', err);
        throw err;
    }
}

async function stopTunnel(url?: string) {
    try {
        const ngrok = await getNgrok();
        
        if (url) {
            await ngrok.disconnect(url);
        } else {
            await ngrok.disconnect();
        }
    } catch (err) {
        console.error('Error stopping ngrok tunnel:', err);
    }
}

export class E2eTestRunner {
    public client: DebuggAIServerClient;

    constructor(client: DebuggAIServerClient) {
        this.client = client;
    }

    async setup() {
        await this.configureNgrok();
    }

    async configureNgrok(): Promise<void> {
        // ngrok binary is downloaded automatically by the ngrok package
    }

    async startTunnel(authToken: string, port: number, url: string): Promise<string> {
        await startTunnel(authToken, port, url);
        console.error(`Tunnel started at: ${url}`);
        return url;
    }

    /**
     * Run E2E test generator for a single file *quietly* in the background.
     * @param filePath absolute path of the file to test
     */
    async runTests(authToken: string, e2eRun: E2eRun): Promise<undefined> {
        // Start by opening an ngrok tunnel.
        // call the debugg ai endpoint to start running the test
        // retrieve the results when done
        // save files locally somewhere
        const listener = await startTunnel(authToken, 3011, `${e2eRun.key}.ngrok.debugg.ai`)
        console.error(`Tunnel started at: ${listener}`);

        const interval = setInterval(async () => {
            const newE2eRun = await this.client.e2es?.getE2eRun(e2eRun.uuid);
            console.error(`E2E run - ${newE2eRun}`);
            if (newE2eRun?.status === 'completed') {
                console.error(`E2E run completed - ${newE2eRun}`);
                clearInterval(interval);
                await stopTunnel(listener);
            }
        }, 1000);
        // if the run doesn't complete in time, disconnect the tunnel
        const setTimer = setTimeout(async () => {
            clearInterval(interval);
            clearTimeout(setTimer);
            await stopTunnel(listener);
        }, 300000);
        return undefined;
    }

    /**
     * Create a new E2E test and run it.
     * @param testPort - The port to use for the test.
     * @param testDescription - The description of the test.
     * @param filePath - The path to the file to test.
     * @param repoName - The name of the repository.
     * @param branchName - The name of the branch.
     * @param repoPath - The path to the repository.
     */
    async createNewE2eTest(testPort: number, testDescription: string, repoName: string, branchName: string, repoPath: string, filePath?: string): Promise<E2eRun | null> {
        console.error(`Creating new E2E test with description: ${testDescription}`);
        const key = uuidv4();
        const e2eTest = await this.client.e2es?.createE2eTest(
            testDescription,
            { filePath: filePath ?? "", repoName: repoName, branchName: branchName, repoPath: repoPath, key: key }
        );
        console.error("E2E test creation response:", JSON.stringify(e2eTest, null, 2));
        const authToken = e2eTest?.tunnelKey;
        if (!authToken) {
            console.error("Failed to get auth token. E2E test response:", e2eTest);
            console.error("Available keys in response:", e2eTest ? Object.keys(e2eTest) : 'null response');
            return null;
        }
        await startTunnel(authToken, testPort, `${key}.ngrok.debugg.ai`);

        console.error(`E2E test created - ${e2eTest}`);
        if (!e2eTest) {
            console.error("Failed to create E2E test.");
            return null;
        }
        if (!e2eTest.curRun) {
            console.error("Failed to create E2E test run.");
            return null;
        }
        return e2eTest.curRun;
    }

    async handleE2eRun(
        e2eRun: E2eRun,
        onUpdate: (updatedRun: E2eRun) => Promise<void>
    ): Promise<E2eRun> {
        console.error(`🔧 Handling E2E run - ${e2eRun.uuid}`);
        console.error(`🌐 Tunnel started at: ${e2eRun.key}.ngrok.debugg.ai`);
    
        let stopped = false;
        let updatedRun: E2eRun | null | undefined = e2eRun;
    
        const timeout = setTimeout(async () => {
            if (stopped) return;
            clearInterval(interval);
            await stopTunnel(`https://${e2eRun.key}.ngrok.debugg.ai`);
            console.error(`⏰ E2E test timed out after 15 minutes`);
            stopped = true;
        }, 900_000);
    
        const interval = setInterval(async () => {
            const latestRun = await this.client.e2es?.getE2eRun(e2eRun.uuid);
            if (!latestRun) return;
    
            updatedRun = latestRun;
            console.error(`📡 Polled E2E run status: ${updatedRun.status}`);
            await onUpdate(updatedRun); // 🔁 Invoke the callback with the updated run
    
            if (updatedRun.status === 'completed') {
                clearInterval(interval);
                clearTimeout(timeout);
                await stopTunnel(`https://${e2eRun.key}.ngrok.debugg.ai`);
                stopped = true;
            }
        }, 1500);
    
        while (!stopped) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    
        return updatedRun!;
    }
    
    async blockingHandleE2eRun(authToken: string, port: number, e2eRun: E2eRun): Promise<E2eRun> {
        console.error(`🔧 Handling E2E run - ${e2eRun.uuid}`);

        // Start ngrok tunnel
        await startTunnel(authToken, port, `${e2eRun.key}.ngrok.debugg.ai`);
        console.error(`🌐 Tunnel started at: ${e2eRun.key}.ngrok.debugg.ai`);

        let stopped = false;
        let lastStep = 0;
        let updatedRun: E2eRun | null | undefined = e2eRun;

        // Poll every second for completion
        const interval = setInterval(async () => {
            updatedRun = await this.client.e2es?.getE2eRun(e2eRun.uuid);
            if (!updatedRun) return;

            console.error(`📡 Polled E2E run status: ${updatedRun.status}`);

            if (updatedRun.status === 'completed') {
                clearInterval(interval);
                clearTimeout(timeout);
                await stopTunnel(`https://${e2eRun.key}.ngrok.debugg.ai`);

                // if (updatedRun.runGif) {
                //     fetchAndOpenGif(this.repoPath ?? "", updatedRun.runGif, updatedRun.test?.name ?? "", updatedRun.uuid);
                // }
                stopped = true;
            } 
        }, 2000);

        // Timeout safeguard
        const timeout = setTimeout(async () => {
            if (stopped) return;
            clearInterval(interval);
            await stopTunnel(`https://${e2eRun.key}.ngrok.debugg.ai`);
            console.error(`⏰ E2E test timed out after 15 minutes\n`);
            stopped = true;
        }, 900_000);

        // Wait for the polling to complete or timeout to expire
        while (!stopped) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        return updatedRun;
    }

}

export default E2eTestRunner;