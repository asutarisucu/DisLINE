import { Buffer } from "node:buffer";
import {
	AttachmentBuilder,
	ChannelType,
	type Client as DiscordClient,
	type Message as DiscordMessage,
	type MessageReaction,
	type PartialMessage,
	type PartialMessageReaction,
	type PartialUser,
	type User as DiscordUser,
	type WebhookClient,
} from "discord.js";
import type * as LINETypes from "@evex/linejs-types";
import type { Client as LineClient, TalkMessage } from "@evex/linejs";
import { config } from "./config.ts";
import { store, type ChatMapping } from "./store.ts";
import { getGuild, openChannel, webhookFor } from "./discord/channels.ts";
import { IdentityCache, contentTypeName, placeholderFor, resolveChatId } from "./line/util.ts";
import {
	downloadMedia,
	downloadSticker,
	hasDownloadableContent,
	isSticker,
	objTypeFor,
	type Media,
} from "./line/media.ts";
import { getClient } from "./line/session.ts";
import { runtime } from "./runtime.ts";
import { cancelPending, consumePending, markPending } from "./echo.ts";

const DISCORD_MESSAGE_LIMIT = 2000;
const UNSENT_PLACEHOLDER = "*🚫 送信が取り消されました*";

const identityCaches = new WeakMap<LineClient, IdentityCache>();

function identities(client: LineClient): IdentityCache {
	let cache = identityCaches.get(client);
	if (!cache) {
		cache = new IdentityCache(client);
		identityCaches.set(client, cache);
	}
	return cache;
}

/** Discordの1メッセージ2000文字制限に合わせて分割する。長文を切り捨てない。 */
function chunk(text: string): string[] {
	if (text.length <= DISCORD_MESSAGE_LIMIT) return [text];
	const parts: string[] = [];
	for (let i = 0; i < text.length; i += DISCORD_MESSAGE_LIMIT) {
		parts.push(text.slice(i, i + DISCORD_MESSAGE_LIMIT));
	}
	return parts;
}

/**
 * トークを既読にする。
 *
 * linejs の `TalkMessage.read()` は宛先に `isMyMessage ? to : from` を使うため、
 * グループのメッセージだと chatMid に「送信者のユーザーmid」を渡してしまう。
 * トークIDは自前で解決したものを渡す。
 */
async function markRead(chatId: string, lineMessageId: string): Promise<void> {
	const lineClient = getClient();
	if (!lineClient) return;
	try {
		await lineClient.base.talk.sendChatChecked({
			chatMid: chatId,
			lastMessageId: lineMessageId,
			seq: await lineClient.base.getReqseq(),
		});
	} catch (error) {
		console.error(`[bridge] 既読の送信に失敗しました (${chatId}):`, error);
	}
}

// ---------------------------------------------------------------- LINE → Discord

/** メッセージが返信なら、引用行を組み立てる。Webhookはネイティブの返信を使えないため。 */
function replyQuote(message: TalkMessage, guildId: string): string | null {
	const relatedId = message.raw.relatedMessageId;
	const relation = message.raw.messageRelationType;
	if (!relatedId || !(relation === 3 || relation === "REPLY")) return null;
	return quoteFor(relatedId, guildId);
}

/** 返信元のLINEメッセージIDから、Discordの元メッセージへ飛べる引用行を作る。 */
function quoteFor(relatedId: string, guildId: string): string {
	const target = store.getLinksByLineId(relatedId)[0];
	if (!target) return "> ↩ *（返信元のメッセージは残っていません）*";

	const preview = (target.preview ?? "").replace(/\s+/g, " ").slice(0, 80);
	const channelId = store.getByChatId(target.chat_id)?.channel_id;
	// チャンネルが自動クローズされているとジャンプ先が無い。引用文だけ出す。
	if (!channelId) return `> ↩ ${preview || "*（返信）*"}`;

	const jump = `https://discord.com/channels/${guildId}/${channelId}/${target.discord_id}`;
	return `> ↩ [返信](${jump})${preview ? ` ${preview}` : ""}`;
}

async function collectAttachment(
	lineClient: LineClient,
	message: TalkMessage,
): Promise<{ media: Media | null; note: string | null }> {
	const kind = contentTypeName(message.raw.contentType);
	try {
		const media = isSticker(kind)
			? await downloadSticker(message.raw.contentMetadata)
			: hasDownloadableContent(kind)
			? await downloadMedia(lineClient, message)
			: null;

		if (!media) return { media: null, note: null };
		if (media.data.byteLength > config.maxUploadBytes) {
			const mb = (media.data.byteLength / 1024 / 1024).toFixed(1);
			return {
				media: null,
				note: `${placeholderFor(kind)}（${mb} MB — Discordに添付できる上限を超えています）`,
			};
		}
		return { media, note: null };
	} catch (error) {
		console.error(`[bridge] ${kind} の取得に失敗しました:`, error);
		return { media: null, note: `${placeholderFor(kind)}（取得に失敗しました）` };
	}
}

export async function handleLineMessage(discord: DiscordClient, message: TalkMessage): Promise<void> {
	// DisLINE 経由で送ったメッセージは polling でも返ってくる。ここで落とさないと二重に出る。
	if (store.wasSentByUs(message.raw.id)) return;
	// pollingの再接続などで同じイベントが再配信されても二重投稿しない。
	if (store.wasPostedToDiscord(message.raw.id)) return;

	const lineClient = getClient();
	if (!lineClient) return;

	const chatId = resolveChatId(message);

	// IDでの照合は「送信レスポンスが先に返ること」が前提で、これは保証されない。
	// 自分の発言に限り、送信直前に登録しておいた (トーク, 本文) でも照合する。
	if (message.isMyMessage && consumePending(chatId, message.raw.text ?? "")) return;

	const cache = identities(lineClient);
	const [chat, sender] = await Promise.all([cache.get(chatId), cache.get(message.raw.from)]);

	store.rememberChat(chatId, chat.name);
	store.touch(chatId);
	store.setLastLineMessage(chatId, message.raw.id);

	const guild = await getGuild(discord);
	// 未登録のトークはここで自動的にチャンネル化する。上限に当たれば古いものが閉じる。
	const { channel } = await openChannel(guild, chatId, chat.name);

	const mapping = store.getByChatId(chatId);
	const webhook = mapping ? webhookFor(mapping) : null;
	if (!webhook) {
		console.error(`[bridge] ${chatId} のWebhookが失われています。/line close して開き直してください。`);
		return;
	}

	const { media, note } = await collectAttachment(lineClient, message);
	const text = message.raw.text?.trim() ?? "";
	// 添付が付くならプレースホルダーは要らない。付けられなかったときだけ理由を出す。
	const body = text || note || (media ? "" : placeholderFor(message.raw.contentType));
	const quote = replyQuote(message, guild.id);
	const parts = chunk([quote, body].filter(Boolean).join("\n"));
	if (parts.length === 0) parts.push("");

	try {
		for (const [index, part] of parts.entries()) {
			const posted = await webhook.send({
				content: part,
				username: sender.name,
				avatarURL: sender.avatar,
				// 添付は先頭のメッセージにだけ付ける。
				files: index === 0 && media ? [new AttachmentBuilder(media.data, { name: media.name })] : [],
				// LINE本文はそのまま外部入力。指定しないと本文中の @everyone がDiscordで発火する。
				allowedMentions: { parse: [] },
			});
			// 既読・返信の引用・送信取消がこの対応表を引く。転送済みの印にもなる。
			store.linkMessage(posted.id, String(message.raw.id), chatId, {
				preview: text || placeholderFor(message.raw.contentType),
			});
		}
	} catch (error) {
		console.error(`[bridge] Webhook送信に失敗しました (${chatId}):`, error);
		if (channel.type === ChannelType.GuildText) {
			await channel
				.send({
					content: `⚠️ LINEからのメッセージを転送できませんでした: ${String(error).slice(0, 1500)}`,
					allowedMentions: { parse: [] },
				})
				.catch(() => null);
		}
	}
}

/**
 * LINE側で送信が取り消されたとき、Discord側の表示も打ち消す。
 *
 * 削除ではなく本文の差し替えにしている。前後の会話の並びが崩れず、
 * 「何かが取り消された」ことがLINEと同じように残るため。
 */
export async function handleLineUnsend(discord: DiscordClient, operation: LINETypes.Operation): Promise<void> {
	const type = operation.type;
	// OpType は文字列名と数値のどちらでも来る。64=DESTROY_MESSAGE, 65=NOTIFIED_DESTROY_MESSAGE
	const isUnsend =
		type === "DESTROY_MESSAGE" || type === "NOTIFIED_DESTROY_MESSAGE" || type === 64 || type === 65;
	if (!isUnsend) return;

	const lineMessageId = operation.param2;
	if (!lineMessageId) return;

	const links = store.getLinksByLineId(lineMessageId);
	if (links.length === 0) return;

	const guild = await getGuild(discord);
	const mapping = store.getByChatId(links[0]!.chat_id);
	const webhook = mapping ? webhookFor(mapping) : null;

	for (const link of links) {
		// 先に対応表から外す。差し替えできず削除に回った場合、その削除イベントを
		// 「Discordで消されたのでLINEでも取り消す」と誤って解釈しないようにするため。
		store.deleteLink(link.discord_id);
		await retractOne(guild, webhook, link, mapping);
	}
}

async function retractOne(
	guild: Awaited<ReturnType<typeof getGuild>>,
	webhook: WebhookClient | null,
	link: { discord_id: string },
	mapping: ChatMapping | undefined,
): Promise<void> {
	// Webhookが投稿したメッセージは本文を差し替えられる。
	if (webhook) {
		try {
			await webhook.editMessage(link.discord_id, { content: UNSENT_PLACEHOLDER, files: [] });
			return;
		} catch {
			// 自分がDiscordから送ったメッセージはWebhook投稿ではないので編集できない。削除に回す。
		}
	}
	if (!mapping?.channel_id) return;
	const channel = await guild.channels.fetch(mapping.channel_id).catch(() => null);
	if (channel?.type !== ChannelType.GuildText) return;
	await channel.messages.delete(link.discord_id).catch(() => null);
}

// ---------------------------------------------------------------- Discord → LINE

export async function handleDiscordMessage(message: DiscordMessage): Promise<void> {
	if (message.author.bot || message.webhookId) return;
	if (message.author.id !== runtime().ownerId) return;

	const mapping = store.getByChannelId(message.channelId);
	if (!mapping) return;

	const lineClient = getClient();
	if (!lineClient) {
		await message.react("⚠️").catch(() => null);
		return;
	}

	// Discordの返信は、対応するLINEメッセージが分かるときだけLINEの返信として送る。
	const repliedTo = message.reference?.messageId;
	const relatedMessageId = repliedTo ? store.getLink(repliedTo)?.line_id : undefined;

	const text = message.cleanContent.trim();
	const posts: { lineId: string; text: string; file: AttachmentBuilder | null }[] = [];

	if (text) {
		const lineId = await sendText(lineClient, message, mapping, text, relatedMessageId);
		if (lineId !== null) posts.push({ lineId, text, file: null });
	}
	for (const attachment of message.attachments.values()) {
		const sent = await sendAttachment(lineClient, message, mapping, attachment);
		if (sent) posts.push({ lineId: sent.lineId, text: "", file: sent.file });
	}
	if (message.stickers.size > 0) {
		await message
			.reply({
				content: "🚫 Discordのスタンプは転送できません（LINEのスタンプIDに対応付けられないため）。",
				allowedMentions: { parse: [] },
			})
			.catch(() => null);
	}

	if (posts.length === 0) return;

	await repostAsWebhook(message, mapping, posts, relatedMessageId);

	store.touch(mapping.chat_id);
	// 返信できたということは読んだということ。そのトークの未読をまとめて既読にする。
	if (mapping.last_line_message_id) {
		await markRead(mapping.chat_id, mapping.last_line_message_id);
	}
}

/**
 * 自分の発言をWebhook経由で投稿し直し、元のメッセージを消す。
 *
 * こうしておくとチャンネル内の全メッセージをBotが所有することになり、
 * 送信取り消しのときに **その場で本文を差し替えられる**（Botは自分がWebhookで
 * 投稿したメッセージしか編集できない）。副産物として、自分の発言もLINEの
 * 表示名とアイコンで並ぶ。
 *
 * 投稿してから消す順序が重要。逆にすると、投稿に失敗したときにメッセージを失う。
 */
async function repostAsWebhook(
	message: DiscordMessage,
	mapping: ChatMapping,
	posts: { lineId: string; text: string; file: AttachmentBuilder | null }[],
	relatedMessageId: string | undefined,
): Promise<void> {
	const webhook = webhookFor(mapping);
	const lineClient = getClient();
	if (!webhook || !lineClient) return;

	const myMid = lineClient.base.profile?.mid;
	const me = myMid ? await identities(lineClient).get(myMid) : { name: "自分", avatar: undefined };
	const quote = relatedMessageId ? quoteFor(relatedMessageId, message.guildId ?? "") : null;

	try {
		for (const post of posts) {
			// LINE側も本文と添付は別メッセージになるので、こちらも1件ずつ投稿して個別に紐づける。
			const parts = chunk([quote, post.text].filter(Boolean).join("\n"));
			if (parts.length === 0) parts.push("");
			for (const [index, part] of parts.entries()) {
				const posted = await webhook.send({
					content: part,
					username: me.name,
					avatarURL: me.avatar,
					files: index === 0 && post.file ? [post.file] : [],
					allowedMentions: { parse: [] },
				});
				if (post.lineId) {
					store.linkMessage(posted.id, post.lineId, mapping.chat_id, {
						outgoing: true,
						preview: post.text || post.file?.name || "添付ファイル",
					});
				}
			}
		}
	} catch (error) {
		// 投稿し直せなかった。元のメッセージは消さずに残す（LINEへは既に届いている）。
		console.error("[bridge] 自分の発言の再投稿に失敗しました:", error);
		return;
	}

	// 元のメッセージには対応表の登録が無いので、この削除で送信取り消しは走らない。
	await message.delete().catch((error: unknown) =>
		console.error("[bridge] 元のメッセージを削除できませんでした（権限「メッセージの管理」が必要です）:", error),
	);
}

/** 送信できたら LINE のメッセージID（応答に無ければ空文字）を、失敗したら null を返す。 */
async function sendText(
	lineClient: LineClient,
	message: DiscordMessage,
	mapping: ChatMapping,
	text: string,
	relatedMessageId: string | undefined,
): Promise<string | null> {
	// 送信レスポンスより先にpollingがこのメッセージを配信してくることがあるので、送る前に登録する。
	markPending(mapping.chat_id, text);
	try {
		const sent = await lineClient.base.talk.sendMessage({
			to: mapping.chat_id,
			text,
			relatedMessageId,
		});
		// e2ee は指定しない。未指定だとE2EEが必要なトークで自動的に暗号化してリトライする。
		if (!sent?.id) {
			console.warn(
				"[bridge] 送信応答にメッセージIDがありませんでした。本文一致による抑止に頼ります:",
				JSON.stringify(sent)?.slice(0, 300),
			);
			return "";
		}
		store.markSent(sent.id);
		return String(sent.id);
	} catch (error) {
		cancelPending(mapping.chat_id, text);
		await reportSendFailure(message, error, "メッセージ");
		return null;
	}
}

async function sendAttachment(
	lineClient: LineClient,
	message: DiscordMessage,
	mapping: ChatMapping,
	attachment: { url: string; name: string; contentType: string | null },
): Promise<{ lineId: string; file: AttachmentBuilder } | null> {
	// uploadMediaByE2EE はユーザー(u)とグループ(c)しか受け付けない。
	const target = mapping.chat_id.charAt(0);
	if (target !== "u" && target !== "c") {
		await message
			.reply({ content: "🚫 このトークには添付ファイルを送信できません。", allowedMentions: { parse: [] } })
			.catch(() => null);
		return null;
	}

	try {
		const response = await fetch(attachment.url);
		if (!response.ok) throw new Error(`Discordからの取得に失敗しました (HTTP ${response.status})`);
		// 取得した中身はLINEへの送信とDiscordへの再投稿の両方で使う。取り直さない。
		const bytes = Buffer.from(await response.arrayBuffer());
		const data = new Blob([bytes], { type: attachment.contentType ?? "application/octet-stream" });

		const sent = await lineClient.base.obs.uploadMediaByE2EE({
			data,
			oType: objTypeFor(attachment.contentType),
			to: mapping.chat_id,
			filename: attachment.name,
		});
		if (sent?.id) store.markSent(sent.id);
		return {
			lineId: sent?.id ? String(sent.id) : "",
			file: new AttachmentBuilder(bytes, { name: attachment.name }),
		};
	} catch (error) {
		await reportSendFailure(message, error, attachment.name);
		return null;
	}
}

async function reportSendFailure(message: DiscordMessage, error: unknown, what: string): Promise<void> {
	console.error(`[bridge] LINEへの送信に失敗しました (${what}):`, error);
	await message.react("❌").catch(() => null);
	await message
		.reply({
			content: `${what}の送信に失敗しました: ${String(error).slice(0, 500)}`,
			allowedMentions: { parse: [] },
		})
		.catch(() => null);
}

/** Discord側でLINEメッセージにリアクションを付けたら、そのメッセージまでを既読にする。 */
export async function handleDiscordReaction(
	reaction: MessageReaction | PartialMessageReaction,
	user: DiscordUser | PartialUser,
): Promise<void> {
	if (user.bot || user.id !== runtime().ownerId) return;

	const link = store.getLink(reaction.message.id);
	if (!link) return;

	await markRead(link.chat_id, link.line_id);
	store.touch(link.chat_id);
}

/**
 * 自分の発言をLINEで取り消し、Discord側の本文もその場で差し替える。
 * 右クリックメニュー（メッセージ → アプリ → LINEで取り消す）から呼ばれる。
 */
export async function retractOwnMessage(
	discord: DiscordClient,
	discordMessageId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const link = store.getLink(discordMessageId);
	if (!link) {
		return { ok: false, reason: "このメッセージに対応するLINEのメッセージが見つかりません。" };
	}
	if (link.outgoing !== 1) {
		return { ok: false, reason: "自分が送ったメッセージだけ取り消せます。" };
	}
	if (!link.line_id) {
		return { ok: false, reason: "送信時にLINEのメッセージIDを取得できていないため取り消せません。" };
	}

	const lineClient = getClient();
	if (!lineClient) return { ok: false, reason: "LINEにログインしていません。" };

	try {
		await lineClient.base.talk.unsendMessage({ messageId: link.line_id });
	} catch (error) {
		console.error(`[bridge] LINEでの送信取消に失敗しました (${link.line_id}):`, error);
		// LINEの送信取り消しには時間制限がある。ここで諦めないとDiscordだけ消えて食い違う。
		return { ok: false, reason: `LINE側で取り消せませんでした: ${String(error).slice(0, 300)}` };
	}

	// LINE側が取り消せたのでDiscordの表示も打ち消す。
	// 対応表を先に外し、この差し替えが削除に落ちた場合でも二重に取り消しにいかないようにする。
	const links = store.getLinksByLineId(link.line_id);
	const guild = await getGuild(discord);
	const mapping = store.getByChatId(link.chat_id);
	const webhook = mapping ? webhookFor(mapping) : null;
	for (const each of links) {
		store.deleteLink(each.discord_id);
		await retractOne(guild, webhook, each, mapping);
	}
	return { ok: true };
}

/**
 * Discordでメッセージが削除されたときの後始末。
 *
 * 自分の発言は再投稿によってWebhookのメッセージになっているので、削除すればLINEでも取り消す。
 * ただし削除されたものは復元できないため、位置を保ったまま残したいなら
 * 右クリックメニューの「LINEで取り消す」を使う。
 */
export async function handleDiscordDelete(message: DiscordMessage | PartialMessage): Promise<void> {
	const link = store.getLink(message.id);
	if (!link || link.outgoing !== 1) return;

	const lineClient = getClient();
	if (!lineClient) return;

	store.deleteLink(message.id);
	try {
		await lineClient.base.talk.unsendMessage({ messageId: link.line_id });
	} catch (error) {
		// LINEの送信取消には期限がある。過ぎていれば失敗するが、Discord側は既に消えている。
		console.error(`[bridge] LINEでの送信取消に失敗しました (${link.line_id}):`, error);
	}
}
