import { register } from "./registry.ts";
import { readFileTool } from "./read_file.ts";
import { listDirTool } from "./list_dir.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { writeFileTool } from "./write_file.ts";
import { editFileTool } from "./edit_file.ts";
import { bashTool } from "./bash.ts";
import { searchHistoryTool } from "./search_history.ts";
import { todoTool } from "./todo.ts";
import { enterPlanModeTool, exitPlanModeTool } from "./plan_mode.ts";

export function setupTools() {
  register(readFileTool);
  register(listDirTool);
  register(globTool);
  register(grepTool);
  register(writeFileTool);
  register(editFileTool);
  register(bashTool);
  register(searchHistoryTool);
  register(todoTool);
  register(enterPlanModeTool);
  register(exitPlanModeTool);
}
