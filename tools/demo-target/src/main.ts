import { createDemoTarget } from "./app.js";

const port = Number(process.env.DEMO_TARGET_PORT ?? 4343);
const { app } = createDemoTarget();

// Localhost only: POST /_secrets has no authentication.
app.listen(port, "127.0.0.1", () => {
  console.log(`[demo-target] http://127.0.0.1:${port}  handlers: /naive, /idempotent`);
});
