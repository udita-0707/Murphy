import { EXIT, parseArgs, readEnv, runCommand, UsageError, USAGE } from "./run.js";

async function main(): Promise<number> {
  // pnpm adds a `--` when passing arguments through a script.
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  if (argv.length === 0 || argv[0] === "--help") {
    console.log(USAGE);
    return argv.length === 0 ? EXIT.usage : 0;
  }
  // Through `pnpm murphy`, this runs in the package's directory. Paths mean the caller's.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  return runCommand(parseArgs(argv), readEnv(process.env), (line) => console.log(line), cwd);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exit(EXIT.usage);
    }
    console.error(err);
    process.exit(EXIT.usage);
  },
);
