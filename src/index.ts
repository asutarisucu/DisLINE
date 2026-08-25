import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { config } from "./config.ts";
import { createInteractionHandler, registerCommands } from "./discord/commands.ts";
import { inviteUrl } from "./discord/permissions.ts";
import { setRuntime } from "./runtime.ts";
import {
	handleDiscordDelete,
	handleDiscordMessage,
	handleDiscordReaction,
	handleLineMessage,
	handleLineUnsend,
} from "./bridge.ts";
import { getClient, resume } from "./line/session.ts";
import { startWatchdog } from "./health.ts";

const discord = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		// 本文を読むには開発者ポータルで MESSAGE CONTENT INTENT を有効にする必要がある。
		GatewayIntentBits.MessageContent,
		// リアクションで既読を送るため。
		GatewayIntentBits.GuildMessageReactions,
	],
	// 再起動前に転送したメッセージはキャッシュに無い。Partialを許可しないとリアクションを拾えない。
	partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

let bridgeStarted = false;

/** LINEのイベント購読を開始する。ログイン直後と再開時の両方から呼ばれるので二重起動を防ぐ。 */
function startBridge(): void {
	if (bridgeStarted) return;
	const lineClient = getClient();
	if (!lineClient) return;

	lineClient.on("message", (message) => {
		void handleLineMessage(discord, message).catch((error: unknown) =>
			console.error("[bridge] LINE→Discord の処理に失敗しました:", error),
		);
	});
	// 送信取消はメッセージではなくオペレーションとして届く。
	lineClient.on("event", (operation) => {
		void handleLineUnsend(discord, operation).catch((error: unknown) =>
			console.error("[bridge] 送信取消の反映に失敗しました:", error),
		);
	});
	lineClient.listen({ talk: true, square: false });
	bridgeStarted = true;
	console.log("[line] トークイベントの購読を開始しました。");
}

/**
 * アプリケーションの所有者。`OWNER_ID` が未設定のときはここから決める。
 * チーム所有のアプリではチームの所有者を使う。
 */
async function resolveOwnerId(ready: Client<true>): Promise<string> {
	if (config.ownerId) return config.ownerId;
	const application = await ready.application.fetch();
	const owner = application.owner;
	if (!owner) {
		throw new Error(
			"アプリケーションの所有者を取得できませんでした。.env に OWNER_ID を設定してください。",
		);
	}
	// Team は ownerId を持つ（取得できないこともある）。User はそれ自身が所有者。
	const id = "ownerId" in owner ? owner.ownerId : owner.id;
	if (!id) {
		throw new Error(
			"チーム所有のアプリケーションで所有者を特定できませんでした。.env に OWNER_ID を設定してください。",
		);
	}
	return id;
}

/** 対象サーバー。`DISCORD_GUILD_ID` が未設定なら、参加している唯一のサーバーを使う。 */
function resolveGuildId(ready: Client<true>): string | null {
	if (config.guildId) return config.guildId;
	const guilds = ready.guilds.cache;
	if (guilds.size === 1) return guilds.firstKey() ?? null;
	if (guilds.size > 1) {
		throw new Error(
			`Botが ${guilds.size} 個のサーバーに参加しています。` +
				".env の DISCORD_GUILD_ID で対象を指定してください。\n" +
				guilds.map((g) => `  ${g.id}  ${g.name}`).join("\n"),
		);
	}
	return null;
}

let setupDone = false;

/** サーバーが決まってからでないとできないこと。招待前に起動された場合は参加を待つ。 */
async function completeSetup(ready: Client<true>, guildId: string, ownerId: string): Promise<void> {
	if (setupDone) return;
	setupDone = true;

	setRuntime({ clientId: ready.application.id, guildId, ownerId });
	const guild = await ready.guilds.fetch(guildId);
	console.log(`[discord] 対象サーバー: ${guild.name} (${guildId})`);

	// 定義が変わったときだけ実際に登録する。再起動のたびに叩くとレート制限に近づく。
	if (await registerCommands(ready, guildId)) {
		console.log("[discord] スラッシュコマンドを登録しました。");
	}

	if (await resume()) {
		console.log("[line] 保存済みセッションで再開しました。");
		startBridge();
	} else {
		console.log("[line] 未ログインです。Discordで /line login を実行してください。");
	}
}

discord.once(Events.ClientReady, async (ready) => {
	console.log(`[discord] ${ready.user.tag} としてログインしました。`);
	startWatchdog();

	const ownerId = await resolveOwnerId(ready);
	console.log(`[discord] 操作を許可するユーザー: ${ownerId}`);

	const guildId = resolveGuildId(ready);
	if (!guildId) {
		// まだどのサーバーにも入っていない。必要な権限つきの招待URLを出して待つ。
		console.log(
			"\n[discord] まだサーバーに参加していません。次のURLを開いて、このBotを自分のサーバーに招待してください。\n\n" +
				`  ${inviteUrl(ready)}\n\n` +
				"招待されたら自動で続きを行います。\n",
		);
		return;
	}
	await completeSetup(ready, guildId, ownerId);
});

// 招待を待っている状態から復帰する。権限を変えて招待し直した場合もここを通る。
discord.on(Events.GuildCreate, (guild) => {
	if (setupDone || !discord.isReady()) return;
	console.log(`[discord] サーバー「${guild.name}」に参加しました。`);
	void (async () => {
		const ownerId = await resolveOwnerId(discord);
		await completeSetup(discord, config.guildId ?? guild.id, ownerId);
	})().catch((error: unknown) => console.error("[discord] 参加後の初期化に失敗しました:", error));
});

// コンテナからの停止要求。既定の10秒で強制終了される前に自分で閉じる。
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		console.log(`[main] ${signal} を受け取りました。終了します。`);
		void discord.destroy().finally(() => process.exit(0));
	});
}

discord.on(Events.InteractionCreate, createInteractionHandler(discord, startBridge));

discord.on(Events.MessageCreate, (message) => {
	void handleDiscordMessage(message).catch((error: unknown) =>
		console.error("[bridge] Discord→LINE の処理に失敗しました:", error),
	);
});

discord.on(Events.MessageReactionAdd, (reaction, user) => {
	void handleDiscordReaction(reaction, user).catch((error: unknown) =>
		console.error("[bridge] リアクションの処理に失敗しました:", error),
	);
});

discord.on(Events.MessageDelete, (message) => {
	void handleDiscordDelete(message).catch((error: unknown) =>
		console.error("[bridge] 削除の反映に失敗しました:", error),
	);
});

// linejs の polling ループは内部で例外を捕まえないため、落ちると橋渡しだけが静かに止まる。
// 気づけないのが一番困るので必ず表に出す。
process.on("unhandledRejection", (reason) => {
	console.error("[fatal] 未処理のPromise拒否:", reason);
});

await discord.login(config.discordToken);
