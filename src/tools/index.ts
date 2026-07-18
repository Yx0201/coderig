import { register } from "./registry.ts";
import { readFileTool } from "./read_file.ts";

export function setupTools() {
  register(readFileTool);
  // 以后加工具：register(writeFileTool); register(bashTool); ...
}
