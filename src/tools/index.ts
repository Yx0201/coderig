import { register } from "./registry.ts";
import { readFileTool } from "./read_file.ts";
import { listDirTool } from "./list_dir.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { writeFileTool } from "./write_file.ts";
import { editFileTool } from "./edit_file.ts";

export function setupTools() {
  register(readFileTool);
  register(listDirTool);
  register(globTool);
  register(grepTool);
  register(writeFileTool);
  register(editFileTool);
}
