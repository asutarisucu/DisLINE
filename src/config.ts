import { resolve } from "node:path";
import { accessSync, constants, mkdirSync } from "node:fs";

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`環境変数 ${name} が設定されていません。.env.example をコピーして .env を作ってください。`,
		);
	}
	return value;
}

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true });

// バインドマウント元がホストに無いと Docker が root 所有で作る。コンテナは非rootで動くので書けない。
// SQLite が SQLITE_CANTOPEN で落ちる前に、何をすればいいかを出す。
try {
	accessSync(dataDir, constants.W_OK);
} catch {
	throw new Error(
		`データ置き場 ${dataDir} に書き込めません。\n` +
			"Dockerで動かしている場合、ホスト側の data/ が root 所有になっています。\n" +
			"  mkdir -p data && sudo chown -R 1000:1000 data\n" +
			"を実行してから起動し直してください。",
	);
}

export const config = {
	discordToken: required("DISCORD_TOKEN"),
	/**
	 * 橋渡し先のサーバー。未設定なら、Botが参加している唯一のサーバーを使う。
	 * 複数のサーバーに参加している場合だけ指定が要る。
	 */
	guildId: process.env.DISCORD_GUILD_ID || undefined,
	/**
	 * このBotを操作できる唯一のDiscordユーザー。ここ以外からの入力はLINEに流さない。
	 * 未設定ならアプリケーションの所有者を使う。
	 */
	ownerId: process.env.OWNER_ID || undefined,
	/** LINEに申告する端末種別。ログイン済みトークンと不一致だと弾かれるので途中で変えないこと。 */
	device: (process.env.LINE_DEVICE ?? "DESKTOPWIN") as "DESKTOPWIN" | "DESKTOPMAC" | "IOSIPAD" | "ANDROID",
	categoryName: process.env.LINE_CATEGORY_NAME ?? "LINE",
	/**
	 * 同時に開いておくチャンネル数の上限。
	 * これを超えると最終活動が最も古いチャンネルから自動で閉じる。
	 * Discordはサーバー全体で500チャンネル・1カテゴリ50チャンネルが上限。
	 */
	maxOpenChannels: Math.max(1, Number(process.env.MAX_OPEN_CHANNELS ?? 40) || 40),
	/**
	 * Discordへ添付するファイルサイズの上限(MB)。
	 * Discordの実際の上限はサーバーのブースト状況で変わる。既定はどの状況でも通る値にしてある。
	 * 超えるものは添付せず、種別とサイズだけ表示する。
	 */
	maxUploadBytes: Math.max(1, Number(process.env.MAX_UPLOAD_MB ?? 8) || 8) * 1024 * 1024,
	dataDir,
	dbPath: resolve(dataDir, "dis-line.db"),
	/** E2EE鍵などlinejsの内部状態。トークンと違い消すと再ログインが必要になる。 */
	lineStoragePath: resolve(dataDir, "line-storage.json"),
};
