/** Built-in AI sites for the sidebar (SPEC §10.1); users can edit or add URLs. */
export interface AiSite {
  name: string;
  url: string;
}

export const AI_PRESETS: AiSite[] = [
  { name: "DeepSeek", url: "https://chat.deepseek.com/" },
  { name: "豆包", url: "https://www.doubao.com/chat/" },
  { name: "Kimi", url: "https://kimi.moonshot.cn/" },
  { name: "通义千问", url: "https://tongyi.aliyun.com/qianwen/" },
  { name: "ChatGPT", url: "https://chatgpt.com/" },
];

export function parseSites(raw: string | undefined): AiSite[] {
  if (!raw) return AI_PRESETS;
  try {
    const parsed = JSON.parse(raw) as AiSite[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : AI_PRESETS;
  } catch {
    return AI_PRESETS;
  }
}

export function serializeSites(sites: AiSite[]): string {
  return JSON.stringify(sites);
}
