import type { E2eRun } from "../services/types.js";

type StepStatus = 'pending' | 'success' | 'error' | 'failed' | 'skipped';

interface Step {
    label: string;
    status: StepStatus;
}

export class RunResultFormatter {
    public steps: Step[] = [];

    public passed(result: E2eRun): boolean {
        return result.status === "completed" && result.outcome === "pass";
    }

    public formatFailures(result: E2eRun): string {
        if (this.passed(result) || !result.outcome) return "";

        return "\n\n❌ Failures:" + "\n" + `> ${result.outcome}`;
    }

    public formatStepsAsMarkdown(): string {
        if (this.steps.length === 0) return "";

        return (
            "\n\n" +
            this.steps
                .map((s, idx) => {
                    const num = `Step ${idx + 1}:`;
                    const label = s.label.padEnd(30);
                    const icon = "✅ Success"
                        // s.status === "pending"
                        //     ? chalk.yellow("⏳ Pending")
                        //     : s.status === "success"
                        //         ? chalk.green("✅ Success")
                        //         : chalk.red("❌ Failed");

                    return `${num} ${label} ${icon}`;
                })
                .join("\n\n")
        );
    }
    public updateStep(label: string, status: StepStatus): void {
        const existing = this.steps.find((s) => s.label === label);
        if (existing) {
            existing.status = status;
        } else {
            this.steps.push({ label, status });
        }

        console.error('updating step. steps ->', this.steps);

        // Clear terminal and redraw
        console.error("\x1Bc"); // ANSI clear screen
        console.error(
            "🧪 E2E Test Progress" +
            `\r\n${this.steps
                .map((s, i) => {
                    const icon =
                        s.status === "pending"
                            ? "⏳"
                            : s.status === "success"
                                ? "✅"
                                : "❌";
                    return `${`Step ${i + 1}:`} ${s.label.padEnd(
                        30
                    )} ${icon}`;
                })
                .join("\r\n")}`
        );
    }

    formatTerminalBox(result: E2eRun): string {
        const header = this.passed(result)
            ? "✅ Test Passed"
            : "❌ Test Failed";

        const body = [
            "Test: " + result.test?.name,
            "Description: " + (result.test?.description ?? "None"),
            "Duration: " + `${result.metrics?.executionTime ?? 0}s`,
            "Status: " + result.status,
            "Outcome: " + result.outcome,
            this.formatStepsAsMarkdown(),
            this.passed(result) ? "" : this.formatFailures(result),
        ]
            .filter(Boolean)
            .join("\n");

        return `${header}\n${body}`;
    }

    formatMarkdownSummary(result: E2eRun): string {
        return [
            `🧪 **Test Name:** ${result.test?.name ?? "Unknown"}`,
            `📄 **Description:** ${result.test?.description ?? "None"}`,
            `⏱ **Duration:** ${result.metrics?.executionTime ?? 0}s`,
            `🔎 **Status:** ${result.status}`,
            `📊 **Outcome:** ${result.outcome}`,
            this.formatStepsAsMarkdown(),
            this.formatFailures(result),
        ]
            .filter(Boolean)
            .join("\n")
            .trim();
    }

    /*
    Terminal uses different formatting than markdown.
    */
    terminalSummary(result: E2eRun): string {
        return [
            `🧪 Test Name: ${result.test?.name ?? "Unknown"}`,
            `📄 Description: ${result.test?.description ?? "None"}`,
            `⏱ Duration: ${result.metrics?.executionTime ?? 0}s`,
            `🔎 Status: ${result.status}`,
            `📊 Outcome: ${result.outcome}`,
            this.formatFailures(result),
        ]
            .filter(Boolean)
            .join("\r\n")
            .trim();
    }
    appendToTestRun(result: E2eRun): void {
        console.error(this.terminalSummary(result));

    }
}
