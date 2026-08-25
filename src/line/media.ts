import { Buffer } from "node:buffer";
import type { Client, TalkMessage } from "@evex/linejs";
import { contentTypeName } from "./util.ts";

export interface Media {
	data: Buffer;
	name: string;
}

/** 中身を運べるメッセージ種別。STICKER は経路が違うので別扱い。 */
const DOWNLOADABLE = new Set(["IMAGE", "VIDEO", "AUDIO", "FILE"]);

const DEFAULT_EXTENSION: Record<string, string> = {
	IMAGE: "jpg",
	VIDEO: "mp4",
	AUDIO: "m4a",
	FILE: "bin",
};

export function hasDownloadableContent(contentType: unknown): boolean {
	return DOWNLOADABLE.has(contentTypeName(contentType));
}

export function isSticker(contentType: unknown): boolean {
	return contentTypeName(contentType) === "STICKER";
}

/**
 * スタンプ画像のURL。
 *
 * linejs にも `TalkMessage.getStickerURL()` があるが、`contentType !== "STICKER"` という
 * 文字列比較で弾くため、種別が数値で来る経路では常に例外になる。自前で組み立てる。
 */
export function stickerUrl(contentMetadata: Record<string, string> | undefined): string | null {
	const id = contentMetadata?.STKID;
	if (!id) return null;
	// STKOPT === "A" はアニメーションスタンプ。DiscordはAPNGをそのまま再生できる。
	const file = contentMetadata?.STKOPT === "A" ? "sticker_animation.png" : "sticker.png";
	return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${encodeURIComponent(id)}/android/${file}`;
}

/** スタンプは公開CDNにあるので認証なしで取れる。 */
export async function downloadSticker(contentMetadata: Record<string, string> | undefined): Promise<Media | null> {
	const url = stickerUrl(contentMetadata);
	if (!url) return null;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`スタンプの取得に失敗しました (HTTP ${response.status})`);
	return {
		data: Buffer.from(await response.arrayBuffer()),
		// 拡張子は .png のままにする。Discordは中身がAPNGならアニメーションとして再生する。
		name: `sticker-${contentMetadata?.STKID ?? "unknown"}.png`,
	};
}

function fileNameFor(message: TalkMessage, fallbackName?: string): string {
	const meta = message.raw.contentMetadata ?? {};
	const given = meta.FILE_NAME ?? fallbackName;
	if (given && given.includes(".")) return given;
	const kind = contentTypeName(message.raw.contentType);
	return `${given || kind.toLowerCase()}.${DEFAULT_EXTENSION[kind] ?? "bin"}`;
}

/**
 * 画像・動画・音声・ファイルの実体を取得する。
 *
 * `TalkMessage.getData()` は使わない。中で `hasContents.includes(contentType)` という
 * 文字列比較をしているため、種別が数値で来ると「中身が無い」と誤判定して例外になる。
 * 取得経路そのものは同じ3通りを順に試す。
 */
export async function downloadMedia(client: Client, message: TalkMessage): Promise<Media> {
	const meta = message.raw.contentMetadata ?? {};

	if (meta.DOWNLOAD_URL) {
		const response = await client.base.fetch(meta.DOWNLOAD_URL);
		if (!response.ok) throw new Error(`ダウンロードに失敗しました (HTTP ${response.status})`);
		return { data: Buffer.from(await response.arrayBuffer()), name: fileNameFor(message) };
	}

	if (message.raw.chunks?.length) {
		const file = await client.base.obs.downloadMediaByE2EE(message.raw);
		if (!file) throw new Error("E2EEメディアの復号に失敗しました。");
		return { data: Buffer.from(await file.arrayBuffer()), name: fileNameFor(message, file.name) };
	}

	const blob = await client.base.obs.downloadMessageData({
		messageId: message.raw.id,
		isPreview: false,
		isSquare: false,
	});
	return { data: Buffer.from(await blob.arrayBuffer()), name: fileNameFor(message) };
}

/** Discordの添付をLINEのどの種別として送るか。 */
export function objTypeFor(mimeType: string | null): "image" | "gif" | "video" | "audio" | "file" {
	const mime = mimeType ?? "";
	if (mime === "image/gif") return "gif";
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	return "file";
}
