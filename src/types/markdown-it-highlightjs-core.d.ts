declare module "markdown-it-highlightjs/core" {
  import type { PluginWithOptions } from "markdown-it";
  import type { HLJSApi, LanguageFn } from "highlight.js";

  export interface HighlightOptions {
    inline?: boolean;
    auto?: boolean;
    code?: boolean;
    register?: Record<string, LanguageFn>;
    hljs?: HLJSApi;
  }

  const highlightjs: PluginWithOptions<HighlightOptions>;
  export default highlightjs;
}
