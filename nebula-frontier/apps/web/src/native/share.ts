import { isNative } from "./platform.js";

export interface ShareInput { title: string; text?: string; url?: string }

/** Native share sheet / Web Share API; falls back to copying the URL. Returns what happened. */
export async function share(input: ShareInput): Promise<"shared" | "copied" | "cancelled"> {
  try {
    if (isNative) {
      const { Share } = await import("@capacitor/share");
      await Share.share({ title: input.title, ...(input.text ? { text: input.text } : {}), ...(input.url ? { url: input.url } : {}) });
      return "shared";
    }
    if (typeof navigator.share === "function") {
      await navigator.share(input);
      return "shared";
    }
    if (input.url) {
      await navigator.clipboard.writeText(input.url);
      return "copied";
    }
  } catch {
    return "cancelled";
  }
  return "cancelled";
}
