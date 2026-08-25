import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

const db = new DatabaseSync(config.dbPath);

// WALは共有メモリ(mmap)を使うため、ネットワーク越しのファイルシステムや
// Docker Desktop(Windows/macOS)のバインドマウント上では "disk I/O error" になる。
// 書き込み手はこのプロセス1つだけなので、使えなければ既定のジャーナルのままで問題ない。
try {
	db.exec("PRAGMA journal_mode = WAL");
} catch (error) {
	console.warn(
		"[store] WALモードを有効にできませんでした。既定のジャーナルで続行します" +
			"（data/ がネットワーク越し、またはDocker Desktopのバインドマウント上にあります）:",
		String(error),
	);
}
db.exec(`
	CREATE TABLE IF NOT EXISTS meta (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS chats (
		chat_id       TEXT PRIMARY KEY,
		name          TEXT NOT NULL,
		channel_id    TEXT UNIQUE,
		webhook_id    TEXT,
		webhook_token TEXT,
		last_active   INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS sent_messages (
		line_id TEXT PRIMARY KEY,
		at      INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS message_links (
		discord_id TEXT PRIMARY KEY,
		line_id    TEXT NOT NULL,
		chat_id    TEXT NOT NULL,
		at         INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_message_links_line ON message_links (line_id);
`);

// 既存DBへの追加。CREATE TABLE IF NOT EXISTS では既にあるテーブルに列が足されない。
function addColumn(table: string, column: string, definition: string): void {
	const columns = new Set(
		(db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name),
	);
	if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("chats", "last_line_message_id", "TEXT");
// 自分がDiscordから送ったものか。Discord側で消されたときにLINEでも取り消すかの判断に使う。
addColumn("message_links", "outgoing", "INTEGER NOT NULL DEFAULT 0");
// 返信の引用に出す本文の冒頭。元メッセージを取り直さずに済ませるため。
addColumn("message_links", "preview", "TEXT");

export interface ChatMapping {
	chat_id: string;
	name: string;
	channel_id: string | null;
	webhook_id: string | null;
	webhook_token: string | null;
	last_active: number;
	/** そのトークで最後に受信したLINEメッセージ。既読を送るときの位置に使う。 */
	last_line_message_id: string | null;
}

export interface MessageLink {
	discord_id: string;
	line_id: string;
	chat_id: string;
	/** 1 なら自分がDiscordから送ったもの。 */
	outgoing: number;
	preview: string | null;
}

const stmt = {
	getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
	setMeta: db.prepare(
		"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	),
	deleteMeta: db.prepare("DELETE FROM meta WHERE key = ?"),
	byChatId: db.prepare("SELECT * FROM chats WHERE chat_id = ?"),
	byChannelId: db.prepare("SELECT * FROM chats WHERE channel_id = ?"),
	openChats: db.prepare("SELECT * FROM chats WHERE channel_id IS NOT NULL ORDER BY last_active DESC"),
	openCount: db.prepare("SELECT COUNT(*) AS n FROM chats WHERE channel_id IS NOT NULL"),
	evictionCandidates: db.prepare(
		"SELECT * FROM chats WHERE channel_id IS NOT NULL AND chat_id != ? ORDER BY last_active ASC LIMIT ?",
	),
	upsertName: db.prepare(
		`INSERT INTO chats (chat_id, name) VALUES (?, ?)
		 ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name`,
	),
	attach: db.prepare(
		"UPDATE chats SET channel_id = ?, webhook_id = ?, webhook_token = ? WHERE chat_id = ?",
	),
	detach: db.prepare(
		"UPDATE chats SET channel_id = NULL, webhook_id = NULL, webhook_token = NULL WHERE chat_id = ?",
	),
	touch: db.prepare("UPDATE chats SET last_active = ? WHERE chat_id = ?"),
	setLastLineMessage: db.prepare("UPDATE chats SET last_line_message_id = ? WHERE chat_id = ?"),
	markSent: db.prepare("INSERT OR REPLACE INTO sent_messages (line_id, at) VALUES (?, ?)"),
	wasSent: db.prepare("SELECT 1 FROM sent_messages WHERE line_id = ?"),
	purgeSent: db.prepare("DELETE FROM sent_messages WHERE at < ?"),
	linkMessage: db.prepare(
		`INSERT OR REPLACE INTO message_links (discord_id, line_id, chat_id, outgoing, preview, at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	),
	getLink: db.prepare("SELECT * FROM message_links WHERE discord_id = ?"),
	linksByLineId: db.prepare("SELECT * FROM message_links WHERE line_id = ? ORDER BY at ASC"),
	hasLineId: db.prepare("SELECT 1 FROM message_links WHERE line_id = ? LIMIT 1"),
	deleteLink: db.prepare("DELETE FROM message_links WHERE discord_id = ?"),
	purgeLinks: db.prepare("DELETE FROM message_links WHERE at < ?"),
};

const LINK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const store = {
	getMeta(key: string): string | undefined {
		const row = stmt.getMeta.get(key) as { value: string } | undefined;
		return row?.value;
	},
	setMeta(key: string, value: string): void {
		stmt.setMeta.run(key, value);
	},
	deleteMeta(key: string): void {
		stmt.deleteMeta.run(key);
	},

	/** チャンネル未作成でも呼ぶ。名前だけ先に覚えておき、開くときに使う。 */
	rememberChat(chatId: string, name: string): void {
		stmt.upsertName.run(chatId, name);
	},
	getByChatId(chatId: string): ChatMapping | undefined {
		return stmt.byChatId.get(chatId) as ChatMapping | undefined;
	},
	getByChannelId(channelId: string): ChatMapping | undefined {
		return stmt.byChannelId.get(channelId) as ChatMapping | undefined;
	},
	openChats(): ChatMapping[] {
		return stmt.openChats.all() as unknown as ChatMapping[];
	},
	openChannelCount(): number {
		return (stmt.openCount.get() as { n: number }).n;
	},
	/** 最終活動が古い順に返す。自動作成が上限に当たったとき、ここから閉じる。 */
	evictionCandidates(exceptChatId: string, limit: number): ChatMapping[] {
		return stmt.evictionCandidates.all(exceptChatId, limit) as unknown as ChatMapping[];
	},
	attachChannel(chatId: string, channelId: string, webhookId: string, webhookToken: string): void {
		stmt.attach.run(channelId, webhookId, webhookToken, chatId);
	},
	detachChannel(chatId: string): void {
		stmt.detach.run(chatId);
	},
	touch(chatId: string, at: number = Date.now()): void {
		stmt.touch.run(at, chatId);
	},
	setLastLineMessage(chatId: string, lineMessageId: string): void {
		stmt.setLastLineMessage.run(lineMessageId, chatId);
	},

	/**
	 * DisLINE 経由で送ったメッセージのIDを記録する。
	 * LINEのpollingは自分の送信も配信してくるので、これが無いとDiscordに二重表示される。
	 * LINEアプリ本体から送ったものは記録が無いのでDiscordに反映される（これは意図した挙動）。
	 */
	markSent(lineMessageId: string | number | bigint | undefined | null): void {
		// LINEのメッセージIDはi64。経路によって文字列と数値のどちらでも来るので必ず文字列に揃える。
		const id = lineMessageId == null ? "" : String(lineMessageId);
		if (!id) return;
		stmt.markSent.run(id, Date.now());
		stmt.purgeSent.run(Date.now() - 60 * 60 * 1000);
	},
	wasSentByUs(lineMessageId: string | number | bigint | undefined | null): boolean {
		const id = lineMessageId == null ? "" : String(lineMessageId);
		if (!id) return false;
		return stmt.wasSent.get(id) !== undefined;
	},

	/**
	 * Discordのメッセージと対応するLINEメッセージを結ぶ。
	 * 既読・返信の引用・送信取消のすべてがこの対応表を引く。
	 */
	linkMessage(
		discordMessageId: string,
		lineMessageId: string,
		chatId: string,
		options: { outgoing?: boolean; preview?: string } = {},
	): void {
		stmt.linkMessage.run(
			discordMessageId,
			String(lineMessageId),
			chatId,
			options.outgoing ? 1 : 0,
			options.preview?.slice(0, 200) ?? null,
			Date.now(),
		);
		stmt.purgeLinks.run(Date.now() - LINK_RETENTION_MS);
	},
	getLink(discordMessageId: string): MessageLink | undefined {
		return stmt.getLink.get(discordMessageId) as MessageLink | undefined;
	},
	/** 1つのLINEメッセージが長文で複数のDiscordメッセージに分割されていることがある。 */
	getLinksByLineId(lineMessageId: string | number | bigint): MessageLink[] {
		return stmt.linksByLineId.all(String(lineMessageId)) as unknown as MessageLink[];
	},
	deleteLink(discordMessageId: string): void {
		stmt.deleteLink.run(discordMessageId);
	},
	/**
	 * そのLINEメッセージを既にDiscordへ転送済みか。
	 * pollingは再接続時に同じイベントを配信し直すことがあるので、転送自体を冪等にする。
	 */
	wasPostedToDiscord(lineMessageId: string | number | bigint | undefined | null): boolean {
		const id = lineMessageId == null ? "" : String(lineMessageId);
		if (!id) return false;
		return stmt.hasLineId.get(id) !== undefined;
	},
};
