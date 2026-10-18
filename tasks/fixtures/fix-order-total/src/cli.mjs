import { quoteOrder } from "./order-service.mjs";

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(`${JSON.stringify(quoteOrder(JSON.parse(input)))}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
