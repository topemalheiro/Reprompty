import { spawn } from "child_process";
import * as vscode from "vscode";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export class CliChat {
  private history: Message[] = [];

  getHistory(): Message[] {
    return this.history;
  }

  clear(): void {
    this.history = [];
  }

  async send(text: string): Promise<string> {
    this.history.push({ role: "user", content: text });

    const config = vscode.workspace.getConfiguration("wrappy");
    const cliPath = config.get<string>("cliPath") || "kimi";
    const cliArgs = config.get<string[]>("cliArgs") || [];

    const fullInput = this.buildPrompt();

    return new Promise((resolve, reject) => {
      const proc = spawn(cliPath, [...cliArgs], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn ${cliPath}: ${err.message}`));
      });

      proc.on("close", (code) => {
        const output = stdout.trim() || stderr.trim();
        if (code !== 0 && !output) {
          reject(new Error(`${cliPath} exited with code ${code}`));
          return;
        }
        this.history.push({ role: "assistant", content: output });
        resolve(output);
      });

      proc.stdin.write(fullInput);
      proc.stdin.end();
    });
  }

  private buildPrompt(): string {
    // Build a plain-text prompt from the shared history.
    // Some CLIs accept multi-turn context; for others this is just the last turn.
    return this.history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
  }
}
