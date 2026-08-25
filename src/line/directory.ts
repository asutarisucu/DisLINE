import { store } from "../store.ts";
import { requireClient } from "./session.ts";
import { profileImageUrl } from "./util.ts";

export interface DirectoryEntry {
	chatId: string;
	name: string;
	kind: "GROUP" | "USER";
}

const TTL_MS = 10 * 60 * 1000;

let cache: DirectoryEntry[] = [];
let fetchedAt = 0;

/**
 * 参加中のグループと友だちの一覧。
 * `/line open` の補完と `/line list` が使う。件数が多いのでTTLで使い回す。
 */
export async function listChats(force = false): Promise<DirectoryEntry[]> {
	if (!force && cache.length > 0 && Date.now() - fetchedAt < TTL_MS) return cache;

	const client = requireClient();
	const entries: DirectoryEntry[] = [];

	const [chats, users] = await Promise.all([
		client.fetchJoinedChats().catch((error: unknown) => {
			console.error("[line] グループ一覧の取得に失敗しました:", error);
			return [];
		}),
		client.fetchUsers().catch((error: unknown) => {
			console.error("[line] 友だち一覧の取得に失敗しました:", error);
			return [];
		}),
	]);

	for (const chat of chats) {
		entries.push({ chatId: chat.mid, name: chat.name || "名称未設定のグループ", kind: "GROUP" });
	}
	for (const user of users) {
		const detail = user.raw.targetProfileDetail;
		entries.push({ chatId: user.mid, name: detail?.profileName || user.mid.slice(0, 8), kind: "USER" });
		// 表示名は取得済みなのでアイコンURLの生成もここで検証しておく（不正なら undefined になるだけ）。
		void profileImageUrl(detail?.picturePath);
	}

	// 一覧に出たものは名前を控えておく。後から chatId だけで開けるようにするため。
	for (const entry of entries) store.rememberChat(entry.chatId, entry.name);

	cache = entries;
	fetchedAt = Date.now();
	return entries;
}

export function search(entries: DirectoryEntry[], query: string): DirectoryEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return entries;
	return entries.filter((e) => e.name.toLowerCase().includes(q) || e.chatId.includes(q));
}

export function invalidate(): void {
	cache = [];
	fetchedAt = 0;
}
