import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import { URL } from "url";

export async function fetchAndOpenGif(projectRoot: string, recordingUrl: string, testName: string, testId: string): Promise<void> {
    const cacheDir = path.join(projectRoot, ".debugg-ai", "e2e-runs");
    console.error('....downloading gif....')
    console.error('cacheDir', cacheDir);
    console.error('testId', testId);
    console.error('recordingUrl', recordingUrl);
    let localUrl = recordingUrl.replace('localhost', 'localhost:8002');
    console.error('localUrl', localUrl);

    await fs.promises.mkdir(cacheDir, { recursive: true });

    const filePath = path.join(cacheDir, `${testName.replace(/[^a-zA-Z0-9]/g, '-')}-${testId.slice(0, 4)}.gif`);
    const fileUrl = new URL(localUrl);

    const file = fs.createWriteStream(filePath);

    console.error(`⬇️ Downloading test recording...`);

    await new Promise<void>((resolve, reject) => {
        console.error('fetching gif', fileUrl);
        if (fileUrl.protocol === 'https:') {
            https.get(localUrl, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download file: ${response.statusCode}`));
                    return;
                }

                response.pipe(file);
                file.on("finish", () => {
                    file.close();
                    resolve();
                });
            }).on("error", (err) => {
                fs.unlinkSync(filePath);
                reject(err);
            });

        } else {
            http.get(localUrl, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download file: ${response.statusCode}`));
                    return;
                }
                response.pipe(file);
                file.on("finish", () => {
                    file.close();
                    resolve();
                });
            }).on("error", (err) => {
                fs.unlinkSync(filePath);
                reject(err);
            });
        }
    });

    console.error(`📂 Opening test recording`);
    // const fileUri = vscode.Uri.file(filePath);
    // await vscode.commands.executeCommand('vscode.open', fileUri);
}
