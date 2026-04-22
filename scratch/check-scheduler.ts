import { scheduler } from "../src/services/background/scheduler.js";
const tasks = await scheduler.getAllTasks();
console.log(JSON.stringify(tasks, null, 2));
process.exit();
