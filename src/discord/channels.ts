import {
	ChannelType,
	WebhookClient,
	type Client as DiscordClient,
	type Guild,
	type CategoryChannel,
	type TextChannel,
} from "discord.js";
import { config } from "../config.ts";
import { store, type ChatMapping } from "../store.ts";
import { runtime } from "../runtime.ts";

/** Discordの上限。1カテゴリに50チャンネルまで。超える分は追加カテゴリに逃がす。 */
const MAX_CHANNELS_PER_CATEGORY = 50;
const CATEGORY_IDS_KEY = "discord.categoryIds";
const INBOX_KEY = "discord.inboxChannelId";

export async function getGuild(discord: DiscordClient): Promise<Guild> {
	return await discord.guilds.fetch(runtime().guildId);
}

/**
 * Discordはチャンネル名の一部の文字を勝手に落とす。落とされた結果が空になると作成が失敗するので
 * こちら側で先に整えてしまう。日本語はそのまま使える。
 */
export function sanitizeChannelName(name: string): string {
	const cleaned = name
		.normalize("NFKC")
		.replace(/[\s　]+/g, "-")
		.replace(/[#@:`,'"?*\\/<>|]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
		.slice(0, 90);
	return cleaned || "line-chat";
}

/**
 * Webhookのusernameは1〜80文字で、"discord" を含むと Discord 側に拒否される。
 * LINEの表示名は任意の文字列なので、そのまま渡すと送信が丸ごと失敗しうる。
 */
export function sanitizeWebhookName(name: string): string {
	const cleaned = name.replace(/discord/gi, "disc0rd").trim().slice(0, 80);
	return cleaned || "LINE";
}

function storedCategoryIds(): string[] {
	const raw = store.getMeta(CATEGORY_IDS_KEY);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

/** 空きのあるLINEカテゴリを返す。全部埋まっていれば新しいカテゴリを作る。 */
export async function pickCategory(guild: Guild): Promise<CategoryChannel> {
	const ids = storedCategoryIds();
	const alive: string[] = [];
	let chosen: CategoryChannel | null = null;

	for (const id of ids) {
		const channel = await guild.channels.fetch(id).catch(() => null);
		if (!channel || channel.type !== ChannelType.GuildCategory) continue;
		alive.push(id);
		if (!chosen && channel.children.cache.size < MAX_CHANNELS_PER_CATEGORY) chosen = channel;
	}

	if (!chosen) {
		const suffix = alive.length === 0 ? "" : `-${alive.length + 1}`;
		chosen = await guild.channels.create({
			name: `${config.categoryName}${suffix}`,
			type: ChannelType.GuildCategory,
		});
		alive.push(chosen.id);
	}

	if (alive.join(",") !== ids.join(",")) store.setMeta(CATEGORY_IDS_KEY, JSON.stringify(alive));
	return chosen;
}

/**
 * 自動で閉じたチャンネルの通知やエラーを出すチャンネル。
 * トークの着信自体は各チャンネルに直接届くので、ここには運用上の記録だけが流れる。
 */
export async function ensureSystemChannel(guild: Guild): Promise<TextChannel> {
	const existingId = store.getMeta(INBOX_KEY);
	if (existingId) {
		const channel = await guild.channels.fetch(existingId).catch(() => null);
		if (channel?.type === ChannelType.GuildText) return channel;
	}
	const category = await pickCategory(guild);
	const channel = await guild.channels.create({
		name: "dis-line-log",
		type: ChannelType.GuildText,
		parent: category.id,
		topic: "DisLINEの動作ログ。自動で閉じたトークや転送エラーがここに出ます。",
	});
	store.setMeta(INBOX_KEY, channel.id);
	return channel;
}

export interface OpenedChannel {
	channel: TextChannel;
	created: boolean;
}

const inFlight = new Map<string, Promise<OpenedChannel>>();

/**
 * トークに対応するDiscordチャンネルを用意する。既にあればそれを返す。
 *
 * 同じトークから短時間に複数のメッセージが届くと、自動作成が同時に走って
 * チャンネルが二重にできる。トークIDごとに処理を直列化して防ぐ。
 */
export function openChannel(guild: Guild, chatId: string, name: string): Promise<OpenedChannel> {
	const running = inFlight.get(chatId);
	if (running) return running;
	const task = createOrReuse(guild, chatId, name).finally(() => inFlight.delete(chatId));
	inFlight.set(chatId, task);
	return task;
}

async function createOrReuse(guild: Guild, chatId: string, name: string): Promise<OpenedChannel> {
	const existing = store.getByChatId(chatId);
	if (existing?.channel_id) {
		const channel = await guild.channels.fetch(existing.channel_id).catch(() => null);
		if (channel?.type === ChannelType.GuildText) return { channel, created: false };
		// Discord側で消されている。マッピングを外して作り直す。
		store.detachChannel(chatId);
	}

	await evictIfNeeded(guild, chatId);
	const category = await pickCategory(guild);
	const channel = await guild.channels.create({
		name: sanitizeChannelName(name),
		type: ChannelType.GuildText,
		parent: category.id,
		// DBを失っても対応関係を復元できるよう、トークIDをトピックに残す。
		topic: `LINE: ${name} | chatId=${chatId}`,
	});
	const webhook = await channel.createWebhook({ name: "DisLINE" });
	if (!webhook.token) throw new Error("Webhookのトークンを取得できませんでした。");

	store.rememberChat(chatId, name);
	store.attachChannel(chatId, channel.id, webhook.id, webhook.token);
	return { channel, created: true };
}

/**
 * 上限に達していれば、最終活動が古いチャンネルから閉じて空きを作る。
 *
 * 黙って消えるとスクロールバックを失ったことに気づけないので、必ずログチャンネルに残す。
 * 閉じてもマッピング上の名前は残るため、次にメッセージが来れば同じ名前で作り直される。
 */
async function evictIfNeeded(guild: Guild, exceptChatId: string): Promise<void> {
	const over = store.openChannelCount() - config.maxOpenChannels + 1;
	if (over <= 0) return;

	const victims = store.evictionCandidates(exceptChatId, over);
	for (const victim of victims) {
		await closeChannel(guild, victim);
		console.log(`[discord] 上限のため「${victim.name}」のチャンネルを閉じました。`);
		try {
			const log = await ensureSystemChannel(guild);
			await log.send({
				content:
					`🗄️ 上限（${config.maxOpenChannels}件）に達したため「**${victim.name}**」を閉じました。` +
					"\n次にメッセージが届けば自動で開き直します（`/line open` でも復活できます）。",
				allowedMentions: { parse: [] },
			});
		} catch (error) {
			console.error("[discord] 自動クローズの通知に失敗しました:", error);
		}
	}
}

/** チャンネルを削除する。マッピング上の名前は残るので `/line open` で復活できる。 */
export async function closeChannel(guild: Guild, mapping: ChatMapping): Promise<void> {
	if (mapping.channel_id) {
		const channel = await guild.channels.fetch(mapping.channel_id).catch(() => null);
		await channel?.delete("DisLINE: チャンネルを閉じました").catch(() => null);
	}
	store.detachChannel(mapping.chat_id);
}

export function webhookFor(mapping: ChatMapping): WebhookClient | null {
	if (!mapping.webhook_id || !mapping.webhook_token) return null;
	return new WebhookClient({ id: mapping.webhook_id, token: mapping.webhook_token });
}
