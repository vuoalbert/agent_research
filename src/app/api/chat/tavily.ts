/**
 * @deprecated Web search and reads moved to Telem: import from `./web-tools`
 * (`web_search` / `web_read`, `createWebServer`). These aliases only keep
 * branches written against the old module compiling; the tools they name are
 * the Telem ones.
 */
export {
  RESEARCH_SERVER as TAVILY_SERVER,
  WEB_SEARCH_TOOL as TAVILY_TOOL,
  WEB_SEARCH_TOOL_ID as TAVILY_TOOL_ID,
  WEB_READ_TOOL as EXTRACT_TOOL,
  WEB_READ_TOOL_ID as EXTRACT_TOOL_ID,
  MAX_READ_URLS as MAX_EXTRACT_URLS,
  createWebServer as createTavilyServer,
  MAX_RESULTS,
  PAGE_CHARS,
  hostOf,
  type PageSeen,
  type Source,
  type ToolActivity,
} from "./web-tools";
