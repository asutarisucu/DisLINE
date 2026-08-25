import {
	ApplicationCommandType,
	AttachmentBuilder,
	ContextMenuCommandBuilder,
	MessageFlags,
	SlashCommandBuilder,
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
	type Client as DiscordClient,
	type Interaction,
	type MessageContextMenuCommandInteraction,
} from "discord.js";
import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { config } from "../config.ts";
import { store } from "../store.ts";
import { closeChannel, ensureSystemChannel, getGuild, openChannel, pickCategory } from "./channels.ts";
import { getClient, loginByQr, logout, requireClient } from "../line/session.ts";
import { invalidate, listChats, search } from "../line/directory.ts";
import { retractOwnMessage } from "../bridge.ts";
import { runtime } from "../runtime.ts";

const RETRACT_COMMAND = "LINEで取り消す";

/**
 * スラッシュコマンドと右クリックメニューを登録する。
 *
 * 起動のたびに登録すると、再起動を繰り返したときにDiscordのコマンド登録レート制限
 * （1サーバーあたり1日200回）に近づく。定義が変わったときだけ実際に叩く。
 */
export async function registerCommands(client: DiscordClient<true>, guildId: string): Promise<boolean> {
	const fingerprint = createHash("sha256").update(JSON.stringify(commandData)).digest("hex").slice(0, 16);
	const key = `commands.fingerprint.${guildId}`;
	if (store.getMeta(key) === fingerprint) return false;

	await client.application.commands.set(commandData, guildId);
	store.setMeta(key, fingerprint);
	return true;
}

export const commandData = [
	new SlashCommandBuilder()
		.setName("line")
		.setDescription("LINEアカウントをこのサーバーに橋渡しします")
		.addSubcommand((s) => s.setName("login").setDescription("QRコードでLINEにログインします"))
		.addSubcommand((s) => s.setName("logout").setDescription("保存されたLINEセッションを破棄します"))
		.addSubcommand((s) => s.setName("status").setDescription("ログイン状態と展開中のトークを表示します"))
		.addSubcommand((s) => s.setName("setup").setDescription("LINEカテゴリとログチャンネルを作成します"))
		.addSubcommand((s) =>
			s
				.setName("list")
				.setDescription("グループと友だちの一覧を表示します")
				.addStringOption((o) => o.setName("query").setDescription("名前で絞り込み").setRequired(false)),
		)
		.addSubcommand((s) =>
			s
				.setName("open")
				.setDescription("トークをチャンネルとして開きます")
				.addStringOption((o) =>
					o.setName("chat").setDescription("トーク名").setRequired(true).setAutocomplete(true),
				),
		)
		.addSubcommand((s) => s.setName("close").setDescription("このチャンネルを閉じます（トーク自体は消えません）"))
		.addSubcommand((s) => s.setName("sync").setDescription("グループ/友だち一覧を取り直します"))
		.toJSON(),
	// メッセージを右クリック（スマホは長押し）→ アプリ → この項目。
	new ContextMenuCommandBuilder()
		.setName(RETRACT_COMMAND)
		.setType(ApplicationCommandType.Message)
		.toJSON(),
];

type StartBridge = () => void;

export function createInteractionHandler(discord: DiscordClient, startBridge: StartBridge) {
	return async function handleInteraction(interaction: Interaction): Promise<void> {
		try {
			if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
			if (interaction.isMessageContextMenuCommand()) return await handleRetract(discord, interaction);
			if (!interaction.isChatInputCommand()) return;
			if (interaction.commandName !== "line") return;

			// 単一ユーザー運用。オーナー以外にはLINEの中身を一切触らせない。
			if (interaction.user.id !== runtime().ownerId) {
				await interaction.reply({
					content: "このBotの操作は所有者のみに許可されています。",
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			switch (interaction.options.getSubcommand()) {
				case "login": return await cmdLogin(interaction, startBridge);
				case "logout": return await cmdLogout(interaction);
				case "status": return await cmdStatus(interaction);
				case "setup": return await cmdSetup(discord, interaction);
				case "list": return await cmdList(interaction);
				case "open": return await cmdOpen(discord, interaction);
				case "close": return await cmdClose(discord, interaction);
				case "sync": return await cmdSync(interaction);
			}
		} catch (error) {
			console.error("[discord] コマンド処理に失敗しました:", error);
			const content = `エラー: ${String(error).slice(0, 1500)}`;
			if (interaction.isRepliable()) {
				const payload = { content, flags: MessageFlags.Ephemeral as const };
				await (interaction.deferred || interaction.replied
					? interaction.followUp(payload)
					: interaction.reply(payload)
				).catch(() => null);
			}
		}
	};
}

// ---------------------------------------------------------------- subcommands

async function cmdLogin(interaction: ChatInputCommandInteraction, startBridge: StartBridge): Promise<void> {
	if (getClient()) {
		await interaction.reply({ content: "すでにログインしています。", flags: MessageFlags.Ephemeral });
		return;
	}
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const login = loginByQr({
		async onQrUrl(url) {
			const png = await QRCode.toBuffer(url, { width: 400, margin: 2 });
			await interaction.editReply({
				content: [
					"LINEアプリで次のQRコードを読み取ってください。",
					"（LINE → 設定 → アカウント → ログイン中の端末 ではなく、ホーム右上のQRリーダーで読み取ります）",
					"",
					"読み取り後に本人確認用の数字が表示されたら、ここにも同じ数字を送ります。",
				].join("\n"),
				files: [new AttachmentBuilder(png, { name: "line-login-qr.png" })],
			});
		},
		async onPincode(pin) {
			await interaction.followUp({
				content: `本人確認番号: **${pin}**\nLINEアプリに表示されている番号と一致することを確認してください。`,
				flags: MessageFlags.Ephemeral,
			});
		},
	});

	try {
		await login;
	} catch (error) {
		await interaction.followUp({
			content: `ログインに失敗しました: ${String(error).slice(0, 1500)}`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	invalidate();
	startBridge();
	const profile = getClient()?.base.profile;
	await interaction.followUp({
		content: `✅ ${profile?.displayName ?? "LINE"} としてログインしました。\`/line setup\` でチャンネルを用意してください。`,
		flags: MessageFlags.Ephemeral,
	});
}

async function cmdLogout(interaction: ChatInputCommandInteraction): Promise<void> {
	await logout();
	invalidate();
	await interaction.reply({
		content: [
			"ローカルのセッションを破棄しました。",
			"LINE側の端末登録は残っています。完全に切るにはLINEアプリの「ログイン中の端末」からも削除してください。",
			"Botを再起動するとpollingが完全に止まります。",
		].join("\n"),
		flags: MessageFlags.Ephemeral,
	});
}

async function cmdStatus(interaction: ChatInputCommandInteraction): Promise<void> {
	const client = getClient();
	const open = store.openChats();
	const lines = [
		client
			? `✅ ログイン中: **${client.base.profile?.displayName ?? "(名前不明)"}**`
			: "❌ 未ログイン（`/line login`）",
		`展開中のチャンネル: ${open.length} 件`,
	];
	if (open.length > 0) {
		lines.push("", ...open.slice(0, 20).map((m) => `- ${m.name} → <#${m.channel_id}>`));
		if (open.length > 20) lines.push(`…ほか ${open.length - 20} 件`);
	}
	await interaction.reply({
		content: lines.join("\n"),
		flags: MessageFlags.Ephemeral,
		allowedMentions: { parse: [] },
	});
}

async function cmdSetup(discord: DiscordClient, interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const guild = await getGuild(discord);
	const category = await pickCategory(guild);
	const log = await ensureSystemChannel(guild);
	await interaction.editReply(
		`カテゴリ **${category.name}** と <#${log.id}> を用意しました。\n` +
			`メッセージが届いたトークは自動でチャンネルになります。同時に開くのは ${config.maxOpenChannels} 件までで、` +
			`超えると最終活動が古いものから閉じます（閉じたことは <#${log.id}> に出ます）。`,
	);
}

async function cmdList(interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	requireClient();
	const query = interaction.options.getString("query") ?? "";
	const matched = search(await listChats(), query);

	if (matched.length === 0) {
		await interaction.editReply(query ? `「${query}」に一致するトークはありません。` : "トークが見つかりません。");
		return;
	}

	const shown = matched.slice(0, 40).map((entry) => {
		const mapping = store.getByChatId(entry.chatId);
		const icon = entry.kind === "GROUP" ? "👥" : "👤";
		return mapping?.channel_id ? `${icon} ${entry.name} → <#${mapping.channel_id}>` : `${icon} ${entry.name}`;
	});
	const footer = matched.length > shown.length ? `\n…ほか ${matched.length - shown.length} 件（queryで絞り込めます）` : "";
	await interaction.editReply({
		content: `${shown.join("\n")}${footer}`.slice(0, 2000),
		allowedMentions: { parse: [] },
	});
}

async function cmdOpen(discord: DiscordClient, interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const chatId = interaction.options.getString("chat", true);
	await openAndReply(discord, interaction, chatId);
}

async function cmdClose(discord: DiscordClient, interaction: ChatInputCommandInteraction): Promise<void> {
	const mapping = store.getByChannelId(interaction.channelId);
	if (!mapping) {
		await interaction.reply({
			content: "このチャンネルはLINEトークに紐づいていません。",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	await interaction.reply({
		content: `「${mapping.name}」のチャンネルを閉じます。トーク自体は残るので \`/line open\` で開き直せます。`,
		flags: MessageFlags.Ephemeral,
	});
	const guild = await getGuild(discord);
	await closeChannel(guild, mapping);
}

async function cmdSync(interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	requireClient();
	invalidate();
	const entries = await listChats(true);
	await interaction.editReply(`グループ/友だち ${entries.length} 件を取得しました。`);
}

// ---------------------------------------------------------------- 取り消し / autocomplete

async function handleRetract(
	discord: DiscordClient,
	interaction: MessageContextMenuCommandInteraction,
): Promise<void> {
	if (interaction.commandName !== RETRACT_COMMAND) return;
	if (interaction.user.id !== runtime().ownerId) {
		await interaction.reply({ content: "所有者のみ操作できます。", flags: MessageFlags.Ephemeral });
		return;
	}
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const result = await retractOwnMessage(discord, interaction.targetId);
	await interaction.editReply(result.ok ? "🚫 送信を取り消しました。" : result.reason);
}

async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
	if (interaction.user.id !== runtime().ownerId || !getClient()) {
		await interaction.respond([]).catch(() => null);
		return;
	}
	const query = interaction.options.getFocused();
	let matched: { name: string; chatId: string }[] = [];
	try {
		matched = search(await listChats(), query);
	} catch {
		matched = [];
	}
	await interaction
		.respond(
			// Discordの選択肢は最大25件。value はトークIDにして同名のトークでも取り違えないようにする。
			matched.slice(0, 25).map((entry) => ({ name: entry.name.slice(0, 100), value: entry.chatId })),
		)
		.catch(() => null);
}

async function openAndReply(
	discord: DiscordClient,
	interaction: ChatInputCommandInteraction,
	chatId: string,
): Promise<void> {
	const known = store.getByChatId(chatId);
	const name = known?.name ?? (search(await listChats(), chatId)[0]?.name ?? chatId);

	const guild = await getGuild(discord);
	const { channel, created } = await openChannel(guild, chatId, name);
	// 手動で開いたものが直後に自動クローズの対象にならないよう、活動時刻を更新しておく。
	store.touch(chatId);
	await interaction.editReply(
		created ? `<#${channel.id}> を作成しました。` : `すでに <#${channel.id}> で開いています。`,
	);
}
