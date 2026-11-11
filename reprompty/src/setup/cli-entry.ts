import { runCli } from "./cli.js";

// Exit only once stdout is flushed: piped output is written asynchronously.
const exit = (code: number) => process.stdout.write("", () => process.exit(code));

runCli(process.argv.slice(2)).then(exit, (err) => {
  process.stderr.write(`Setup crashed: ${err instanceof Error ? (err.stack ?? err.message) : err}\n`);
  exit(2);
});
