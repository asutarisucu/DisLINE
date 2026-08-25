/**
 * 起動時に確定する値。
 *
 * アプリID・所有者・対象サーバーは、環境変数で指定されていなければ
 * Discordへの接続後に自動で判別する（index.ts が設定する）。
 * 設定されるまで参照されることは無いが、万一そうなったときに何が起きたか分かるようにしておく。
 */
export interface Runtime {
	clientId: string;
	guildId: string;
	ownerId: string;
}

let current: Runtime | null = null;

export function setRuntime(value: Runtime): void {
	current = value;
}

export function runtime(): Runtime {
	if (!current) {
		throw new Error("起動処理がまだ完了していません（対象サーバーの判別前です）。");
	}
	return current;
}

export function isReady(): boolean {
	return current !== null;
}
