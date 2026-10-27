import site from "../../site.config.ts";
import { cached, fetchText } from "./remote-cache.ts";

export interface Video {
  title: string;
  url: string;
  thumbnail: string;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

let pending: Promise<Video> | null = null;

/** Vídeo mais recente do canal (RSS público do YouTube, cache de 3 h) ou o `fallback` da config. */
export function latestVideo(): Promise<Video> {
  pending ??= (async () => {
    const { channelId, fallback } = site.sidebar.youtube;
    if (!channelId) return fallback;
    const video = await cached(`youtube-${channelId}`, 3 * 3600_000, async () => {
      const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
      const entry = xml.split("<entry>")[1];
      const id = entry?.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
      const title = entry?.match(/<title>([^<]+)<\/title>/)?.[1];
      if (!id || !title) throw new Error("feed do YouTube sem vídeos");
      return { title: decode(title), url: `https://www.youtube.com/watch?v=${id}`, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
    });
    return video ?? fallback;
  })();
  return pending;
}
