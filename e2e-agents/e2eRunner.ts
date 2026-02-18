import { DebuggAIServerClient } from '../services/index.js';
import { E2eRun } from '../services/types.js';
import { RunResultFormatter } from './resultsFormatter.js';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';

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

export interface FailureDetail {
    testName: string;
    message: string;
    location?: any;
}

export interface RunResult {
    filePath: string;
    ok: boolean;
    durationMs?: number;
    failures: FailureDetail[];
    stdout: string;
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

const POLL_INTERVAL_MS = 1500;
const TIMEOUT_MS = 900_000; // 15 minutes

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
     * Create a new E2E test and run it.
     */
    async createNewE2eTest(
        testPort: number,
        testDescription: string,
        repoName: string,
        branchName: string,
        repoPath: string,
        filePath?: string
    ): Promise<E2eRun | null> {
        console.error(`Creating new E2E test with description: ${testDescription}`);
        const key = uuidv4();
        const e2eTest = await this.client.e2es?.createE2eTest(
            testDescription,
            { filePath: filePath ?? "", repoName, branchName, repoPath, key }
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

    /**
     * Poll an E2E run until it completes or times out.
     *
     * Uses a safe async loop — no setInterval race conditions.
     * The tunnel is stopped in a finally block so cleanup always runs
     * regardless of how the loop exits (completion, timeout, or error).
     *
     * onUpdate is called on every poll tick so progress notifications
     * fire at a steady cadence and keep the MCP connection alive.
     */
    async handleE2eRun(
        e2eRun: E2eRun,
        onUpdate: (updatedRun: E2eRun) => Promise<void>
    ): Promise<E2eRun> {
        const tunnelUrl = `https://${e2eRun.key}.ngrok.debugg.ai`;
        const startTime = Date.now();
        let updatedRun: E2eRun = e2eRun;

        console.error(`🔧 Handling E2E run - ${e2eRun.uuid}`);
        console.error(`🌐 Tunnel: ${tunnelUrl}`);

        try {
            while (true) {
                if (Date.now() - startTime >= TIMEOUT_MS) {
                    console.error('⏰ E2E test timed out after 15 minutes');
                    break;
                }

                await this._sleep(POLL_INTERVAL_MS);

                try {
                    const latestRun = await this.client.e2es?.getE2eRun(e2eRun.uuid);
                    if (latestRun) {
                        updatedRun = latestRun;
                    }
                } catch (pollError) {
                    console.error(`⚠️ Poll error (continuing): ${pollError}`);
                }

                console.error(`📡 Polled E2E run status: ${updatedRun.status}`);

                // Always fire onUpdate — keeps MCP progress notifications alive
                // even when the run is loading or the poll returned null
                await onUpdate(updatedRun);

                if (updatedRun.status === 'completed') {
                    break;
                }
            }
        } finally {
            await this._stopTunnel(tunnelUrl);
        }

        return updatedRun;
    }

    // Overridable in tests
    protected async _sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    protected async _stopTunnel(url: string): Promise<void> {
        await stopTunnel(url);
    }
}

export default E2eTestRunner;
