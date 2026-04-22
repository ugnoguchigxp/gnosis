import { scheduler } from "../src/services/background/scheduler.js";
scheduler.updateTaskStatus("periodic-synthesis", "pending");
console.log("Reset periodic-synthesis");
process.exit();
