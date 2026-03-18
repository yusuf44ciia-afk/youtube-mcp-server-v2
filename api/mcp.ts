import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_KEY = process.env.YOUTUBE_API_KEY || "";
const BASE_URL = "https://www.googleapis.com/youtube/v3";

async function ytFetch(endpoint: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("key", API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`YouTube API error (${res.status}): ${err}`);
  }
  return res.json();
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function createServer(): McpServer {
  const server = new McpServer({ name: "youtube-mcp-server", version: "1.0.0" });

  server.registerTool("yt_channel_stats", {
    title: "YouTube Channel Statistics",
    description: "Get stats for a YouTube channel. Provide channel_id OR by_username (handle like @AsmonTV).",
    inputSchema: {
      channel_id: z.string().optional().describe("YouTube channel ID"),
      by_username: z.string().optional().describe("Channel handle e.g. @AsmonTV"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ channel_id, by_username }) => {
    let data: any;
    if (by_username) {
      const handle = by_username.startsWith("@") ? by_username.slice(1) : by_username;
      data = await ytFetch("channels", { part: "snippet,statistics", forHandle: handle });
    } else if (channel_id) {
      data = await ytFetch("channels", { part: "snippet,statistics", id: channel_id });
    } else {
      return { content: [{ type: "text" as const, text: "Error: Provide channel_id or by_username" }] };
    }
    const ch = data?.items?.[0];
    if (!ch) return { content: [{ type: "text" as const, text: "Channel not found" }] };
    const s = ch.statistics, sn = ch.snippet;
    return { content: [{ type: "text" as const, text: `Channel: ${sn.title} (${sn.customUrl})\nSubscribers: ${fmt(Number(s.subscriberCount))}\nTotal Views: ${fmt(Number(s.viewCount))}\nVideos: ${s.videoCount}\nCountry: ${sn.country || "N/A"}\nCreated: ${sn.publishedAt}\nChannel ID: ${ch.id}` }] };
  });

  server.registerTool("yt_recent_videos", {
    title: "YouTube Recent Videos",
    description: "Get recent videos from a channel with view counts, likes, and dates.",
    inputSchema: {
      channel_id: z.string().describe("YouTube channel ID"),
      max_results: z.number().int().min(1).max(50).default(20).describe("Number of videos (1-50)"),
      order: z.enum(["date", "viewCount"]).default("date").describe("Sort: date or viewCount"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ channel_id, max_results, order }) => {
    const sd: any = await ytFetch("search", { part: "id", channelId: channel_id, type: "video", order, maxResults: max_results.toString() });
    const ids = sd.items?.map((i: any) => i.id.videoId).filter(Boolean);
    if (!ids?.length) return { content: [{ type: "text" as const, text: "No videos found" }] };
    const vd: any = await ytFetch("videos", { part: "snippet,statistics", id: ids.join(",") });
    let total = 0;
    const lines = vd.items.map((v: any, i: number) => {
      const views = Number(v.statistics.viewCount || 0);
      total += views;
      return `${i + 1}. ${v.snippet.title}\n   Views: ${fmt(views)} | Likes: ${fmt(Number(v.statistics.likeCount || 0))} | Date: ${v.snippet.publishedAt.slice(0, 10)}`;
    });
    return { content: [{ type: "text" as const, text: `${vd.items.length} videos | Total: ${fmt(total)} | Avg: ${fmt(Math.round(total / vd.items.length))}/video\n\n${lines.join("\n\n")}` }] };
  });

  server.registerTool("yt_video_details", {
    title: "YouTube Video Details",
    description: "Get detailed info about a specific video by its ID.",
    inputSchema: { video_id: z.string().describe("YouTube video ID") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ video_id }) => {
    const data: any = await ytFetch("videos", { part: "snippet,statistics,contentDetails", id: video_id });
    const v = data?.items?.[0];
    if (!v) return { content: [{ type: "text" as const, text: "Video not found" }] };
    return { content: [{ type: "text" as const, text: `Title: ${v.snippet.title}\nChannel: ${v.snippet.channelTitle}\nViews: ${fmt(Number(v.statistics.viewCount))}\nLikes: ${fmt(Number(v.statistics.likeCount || 0))}\nComments: ${fmt(Number(v.statistics.commentCount || 0))}\nDuration: ${v.contentDetails.duration}\nPublished: ${v.snippet.publishedAt}\nTags: ${(v.snippet.tags || []).slice(0, 10).join(", ") || "None"}` }] };
  });

  server.registerTool("yt_search", {
    title: "Search YouTube",
    description: "Search for videos, channels, or playlists on YouTube.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      type: z.enum(["video", "channel", "playlist"]).default("video"),
      max_results: z.number().int().min(1).max(25).default(10),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, type, max_results }) => {
    const data: any = await ytFetch("search", { part: "snippet", q: query, type, maxResults: max_results.toString() });
    if (!data.items?.length) return { content: [{ type: "text" as const, text: "No results" }] };
    const results = data.items.map((item: any, i: number) => {
      const id = item.id.videoId || item.id.channelId || item.id.playlistId;
      return `${i + 1}. ${item.snippet.title}\n   Channel: ${item.snippet.channelTitle} | ID: ${id}`;
    });
    return { content: [{ type: "text" as const, text: `Results for "${query}":\n\n${results.join("\n\n")}` }] };
  });

  server.registerTool("yt_compare_channels", {
    title: "Compare YouTube Channels",
    description: "Compare stats of 2-5 YouTube channels. Provide comma-separated channel IDs.",
    inputSchema: { channel_ids: z.string().describe("Comma-separated channel IDs") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ channel_ids }) => {
    const ids = channel_ids.split(",").map(s => s.trim()).filter(Boolean);
    if (ids.length < 2 || ids.length > 5) return { content: [{ type: "text" as const, text: "Provide 2-5 channel IDs" }] };
    const data: any = await ytFetch("channels", { part: "snippet,statistics", id: ids.join(",") });
    if (!data.items?.length) return { content: [{ type: "text" as const, text: "No channels found" }] };
    const lines = data.items.map((ch: any) => {
      const s = ch.statistics;
      return `${ch.snippet.title}\n   Subs: ${fmt(Number(s.subscriberCount))} | Views: ${fmt(Number(s.viewCount))} | Videos: ${s.videoCount}`;
    });
    return { content: [{ type: "text" as const, text: `Channel Comparison:\n\n${lines.join("\n\n")}` }] };
  });

  server.registerTool("yt_channel_analytics", {
    title: "YouTube Channel Video Analytics",
    description: "Analyze recent video performance: total views, averages, top/bottom performers.",
    inputSchema: {
      channel_id: z.string().describe("YouTube channel ID"),
      video_count: z.number().int().min(1).max(50).default(30).describe("Videos to analyze (1-50)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ channel_id, video_count }) => {
    const sd: any = await ytFetch("search", { part: "id", channelId: channel_id, type: "video", order: "date", maxResults: video_count.toString() });
    const ids = sd.items?.map((i: any) => i.id.videoId).filter(Boolean);
    if (!ids?.length) return { content: [{ type: "text" as const, text: "No videos found" }] };
    const vd: any = await ytFetch("videos", { part: "snippet,statistics", id: ids.join(",") });
    const videos = vd.items.map((v: any) => ({ title: v.snippet.title, views: Number(v.statistics.viewCount || 0), likes: Number(v.statistics.likeCount || 0), comments: Number(v.statistics.commentCount || 0), date: v.snippet.publishedAt }));
    const totalV = videos.reduce((s: number, v: any) => s + v.views, 0);
    const totalL = videos.reduce((s: number, v: any) => s + v.likes, 0);
    const sorted = [...videos].sort((a: any, b: any) => b.views - a.views);
    const top3 = sorted.slice(0, 3).map((v: any, i: number) => `   ${i + 1}. ${v.title} (${fmt(v.views)})`).join("\n");
    const bot3 = sorted.slice(-3).reverse().map((v: any, i: number) => `   ${i + 1}. ${v.title} (${fmt(v.views)})`).join("\n");
    return { content: [{ type: "text" as const, text: `Last ${videos.length} videos:\n\nTotal Views: ${fmt(totalV)}\nAvg Views: ${fmt(Math.round(totalV / videos.length))}\nAvg Likes: ${fmt(Math.round(totalL / videos.length))}\nLike/View: ${((totalL / totalV) * 100).toFixed(1)}%\n\nTOP 3:\n${top3}\n\nBOTTOM 3:\n${bot3}\n\nRange: ${videos[videos.length - 1]?.date?.slice(0, 10)} to ${videos[0]?.date?.slice(0, 10)}` }] };
  });

  return server;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({ status: "ok", server: "youtube-mcp-server" });
    return;
  }

  if (req.method === "DELETE") {
    res.status(200).json({ status: "session ended" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).end("Method not allowed");
    return;
  }

  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
