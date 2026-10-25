import { parseReceiverArgs, USAGE } from "./args.js";
import { startReceiver } from "./receiver.js";

let options;
try {
  options = parseReceiverArgs(
    process.argv.slice(2).filter((a) => a !== "--"),
    process.env,
  );
} catch (err) {
  console.error(`${(err as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (options === "help") {
  console.log(USAGE);
  process.exit(0);
}

const receiver = await startReceiver(options);
console.log(`[receiver] listening on ${receiver.url}`);
console.log(
  options.secret
    ? "[receiver] verifying signatures with the given secret"
    : "[receiver] no --secret given: signatures are NOT checked",
);
console.log(`[receiver] behaviour: ${JSON.stringify(receiver.behaviour)}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void receiver.close().then(() => process.exit(0)));
}
