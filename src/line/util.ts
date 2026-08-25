import type { Client, TalkMessage } from "@evex/linejs";

/**
 * mid の先頭1文字から種別を判定する。
 * linejs-types の MIDType / ContentType は「文字列名」と「数値」のどちらも取りうる union なので、
 * `toType === "GROUP"` のような比較は経路によっては外れる。mid の接頭辞は曖昧さが無い。
 */
export function midKind(mid: string): "USER" | "ROOM" | "GROUP" | "SQUARE" | "SQUARE_CHAT" | "BOT" | "UNKNOWN" {
	switch (mid.charAt(0)) {
		case "u": return "USER";
		case "r": return "ROOM";
		case "c": return "GROUP";
		case "s": return "SQUARE";
		case "m": return "SQUARE_CHAT";
		case "v": return "BOT";
		default: return "UNKNOWN";
	}
}

/**
 * メッセージが属するトークのIDを返す。
 *
 * グループ/ルームは to がそのままトークID。
 * 1:1 トークの to は「宛先」なので、受信したメッセージでは to が自分自身になる。
 * その場合は相手である from をトークIDとして扱う。
 */
export function resolveChatId(message: TalkMessage): string {
	const to = message.raw.to;
	const kind = midKind(to);
	if (kind === "GROUP" || kind === "ROOM") return to;
	return message.isMyMessage ? to : message.raw.from;
}

const CONTENT_TYPE_NAMES = [
	"NONE", "IMAGE", "VIDEO", "AUDIO", "HTML", "PDF", "CALL", "STICKER",
	"PRESENCE", "GIFT", "GROUPBOARD", "APPLINK", "LINK", "CONTACT", "FILE",
	"LOCATION", "POSTNOTIFICATION", "RICH", "CHATEVENT", "MUSIC", "PAYMENT",
	"EXTIMAGE", "FLEX",
] as const;

/** ContentType が数値で来ても文字列で来ても名前に揃える。 */
export function contentTypeName(contentType: unknown): string {
	if (typeof contentType === "number") return CONTENT_TYPE_NAMES[contentType] ?? `UNKNOWN(${contentType})`;
	if (typeof contentType === "string") return contentType;
	return "NONE";
}

/** テキスト以外は第1段階では中身を運ばない。落としたことが分かる表示だけ出す。 */
const PLACEHOLDERS: Record<string, string> = {
	IMAGE: "🖼️ 画像",
	VIDEO: "🎞️ 動画",
	AUDIO: "🎤 ボイスメッセージ",
	STICKER: "🎨 スタンプ",
	FILE: "📎 ファイル",
	LOCATION: "📍 位置情報",
	CONTACT: "👤 連絡先",
	GIFT: "🎁 ギフト",
	CALL: "📞 通話",
	FLEX: "🧩 リッチメッセージ",
	LINK: "🔗 リンク",
	MUSIC: "🎵 ミュージック",
	POSTNOTIFICATION: "📰 タイムライン投稿",
	CHATEVENT: "ℹ️ トークイベント",
};

export function placeholderFor(contentType: unknown): string {
	const name = contentTypeName(contentType);
	return PLACEHOLDERS[name] ?? `📦 ${name}`;
}

/** picturePath (例 "/0hAbCd...") を表示可能なURLにする。壊れていれば undefined。 */
export function profileImageUrl(picturePath: string | undefined): string | undefined {
	if (!picturePath) return undefined;
	const path = picturePath.startsWith("/") ? picturePath : `/${picturePath}`;
	try {
		return new URL(path, "https://profile.line-scdn.net").toString();
	} catch {
		return undefined;
	}
}

export interface Identity {
	name: string;
	avatar: string | undefined;
}

/**
 * mid → 表示名/アイコン。メッセージ1件ごとにLINEへ問い合わせると即座にレート制限に当たるのでキャッシュする。
 */
export class IdentityCache {
	#client: Client;
	#cache = new Map<string, { value: Identity; at: number }>();
	#warned = new Set<string>();
	#ttlMs: number;

	constructor(client: Client, ttlMinutes = 60) {
		this.#client = client;
		this.#ttlMs = ttlMinutes * 60 * 1000;
	}

	async get(mid: string): Promise<Identity> {
		const hit = this.#cache.get(mid);
		if (hit && Date.now() - hit.at < this.#ttlMs) return hit.value;

		const value = await this.#fetch(mid);
		this.#cache.set(mid, { value, at: Date.now() });
		return value;
	}

	forget(mid: string): void {
		this.#cache.delete(mid);
	}

	async #fetch(mid: string): Promise<Identity> {
		const kind = midKind(mid);
		if (kind === "GROUP" || kind === "ROOM") return await this.#fetchChat(mid, kind);
		return await this.#fetchUser(mid);
	}

	async #fetchChat(mid: string, kind: "GROUP" | "ROOM"): Promise<Identity> {
		try {
			const chat = await this.#client.getChat(mid);
			const name = chat.name || (kind === "ROOM" ? "複数人トーク" : "名称未設定のグループ");
			return { name, avatar: profileImageUrl(chat.raw.picturePath) };
		} catch (error) {
			this.#warn(mid, error);
			return { name: kind === "ROOM" ? "複数人トーク" : "グループ", avatar: undefined };
		}
	}

	/**
	 * ユーザーの表示名とアイコン。
	 *
	 * linejs の `Client.getUser()` は getContactsV3 だけを叩き、フォールバックが無い。
	 * このRPCはアカウントによって "API method not capable" で落ちたり空配列を返したりするため、
	 * それだけに頼ると表示名が全部midの断片になる。V2 → getContact まで順に試す。
	 */
	async #fetchUser(mid: string): Promise<Identity> {
		const me = this.#client.base.profile;
		if (me && mid === me.mid) {
			return { name: me.displayName || "自分", avatar: profileImageUrl(me.picturePath) };
		}

		const base = this.#client.base;
		let lastError: unknown;

		try {
			const res = await base.relation.getContactsV3({ mids: [mid] });
			const detail = res.responses?.[0]?.targetProfileDetail;
			if (detail?.profileName) {
				return { name: detail.profileName, avatar: profileImageUrl(detail.picturePath) };
			}
		} catch (error) {
			lastError = error;
		}

		try {
			const res = await base.talk.getContactsV2({ mids: [mid] });
			const contact = res.contacts?.[mid]?.contact;
			// displayNameOverridden はLINEの「表示名を編集」で自分が付けた名前。あるならそちらを優先する。
			const name = contact?.displayNameOverridden || contact?.displayName;
			if (name) return { name, avatar: profileImageUrl(contact?.picturePath) };
		} catch (error) {
			lastError = error;
		}

		try {
			const contact = await base.talk.getContact({ mid });
			const name = contact?.displayNameOverridden || contact?.displayName;
			if (name) return { name, avatar: profileImageUrl(contact.picturePath) };
		} catch (error) {
			lastError = error;
		}

		// 全部だめだった。退会済み・ブロック・未知の相手など。なぜ出せないのかをログに残す。
		this.#warn(mid, lastError);
		return { name: `不明なユーザー (${mid.slice(0, 8)})`, avatar: undefined };
	}

	/** 同じmidで毎回ログを出すとpollingのたびに溢れるので1回だけにする。 */
	#warn(mid: string, error: unknown): void {
		if (this.#warned.has(mid)) return;
		this.#warned.add(mid);
		console.warn(`[line] ${mid} の表示名を取得できませんでした:`, error ?? "(該当なし)");
	}
}
