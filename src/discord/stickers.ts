import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MediaGalleryBuilder,
	MessageFlags,
	StringSelectMenuBuilder,
	TextDisplayBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { store } from "../store.ts";
import { requireClient } from "../line/session.ts";
import { getPackageDetail, listOwnedPackages, previewUrl, type StickerPackage } from "../line/stickers.ts";
import { sendSticker } from "../bridge.ts";

/** 1ページに並べる数。Discordのメディアギャラリーは9枚だと3×3に並ぶ。 */
const GRID_SIZE = 9;
export const STICKER_PREFIX = "stk:";

/**
 * 操作の状態はメッセージ側に持たせず custom_id に入れる。
 * 再起動をまたいでも、表示中のボタンがそのまま使える。
 *
 *   stk:grid:<パッケージ>:<ページ>          ページ送り・プレビューから戻る
 *   stk:pick:<パッケージ>:<ページ>          グリッドから1つ選ぶ（値はスタンプID）
 *   stk:send:<パッケージ>:<ページ>:<スタンプ> 送信
 *   stk:cancel
 */
type Ui = {
	components: (TextDisplayBuilder | MediaGalleryBuilder | ActionRowBuilder<any>)[];
	flags: MessageFlags.IsComponentsV2;
};

async function packageById(packageId: string): Promise<StickerPackage> {
	const client = requireClient();
	const found =
		(await listOwnedPackages(client)).find((p) => p.id === packageId) ??
		(await listOwnedPackages(client, true)).find((p) => p.id === packageId);
	if (!found) throw new Error("このスタンプは持っていないか、一覧から消えています。");
	return found;
}

async function gridView(pkg: StickerPackage, requestedPage: number): Promise<Ui> {
	const { stickerIds, animated } = await getPackageDetail(pkg.id);
	if (stickerIds.length === 0) throw new Error("このパッケージにはスタンプが入っていません。");

	const pages = Math.ceil(stickerIds.length / GRID_SIZE);
	const page = Math.min(Math.max(requestedPage, 0), pages - 1);
	const start = page * GRID_SIZE;
	const shown = stickerIds.slice(start, start + GRID_SIZE);

	const gallery = new MediaGalleryBuilder().addItems(
		shown.map((id, i) => (item) => item.setURL(previewUrl(id, animated)).setDescription(`${start + i + 1}`)),
	);
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${STICKER_PREFIX}pick:${pkg.id}:${page}`)
		.setPlaceholder("送るスタンプを選ぶ（左上から順に番号）")
		.addOptions(shown.map((id, i) => ({ label: `${start + i + 1}`, value: id })));
	const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${STICKER_PREFIX}grid:${pkg.id}:${page - 1}`)
			.setLabel("◀")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page === 0),
		new ButtonBuilder()
			.setCustomId(`${STICKER_PREFIX}grid:${pkg.id}:${page + 1}`)
			.setLabel("▶")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page >= pages - 1),
		new ButtonBuilder().setCustomId(`${STICKER_PREFIX}cancel`).setLabel("やめる").setStyle(ButtonStyle.Secondary),
	);

	return {
		flags: MessageFlags.IsComponentsV2,
		components: [
			new TextDisplayBuilder().setContent(`**${pkg.name}**　${page + 1} / ${pages} ページ`),
			gallery,
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
			nav,
		],
	};
}

async function previewView(pkg: StickerPackage, page: number, stickerId: string): Promise<Ui> {
	const { stickerIds, animated } = await getPackageDetail(pkg.id);
	const number = stickerIds.indexOf(stickerId) + 1;
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [
			new TextDisplayBuilder().setContent(`**${pkg.name}** の ${number} 番をこのトークに送ります。`),
			new MediaGalleryBuilder().addItems((item) => item.setURL(previewUrl(stickerId, animated))),
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${STICKER_PREFIX}send:${pkg.id}:${page}:${stickerId}`)
					.setLabel("送信")
					.setStyle(ButtonStyle.Primary),
				new ButtonBuilder()
					.setCustomId(`${STICKER_PREFIX}grid:${pkg.id}:${page}`)
					.setLabel("戻る")
					.setStyle(ButtonStyle.Secondary),
			),
		],
	};
}

function textView(content: string): Ui {
	return { flags: MessageFlags.IsComponentsV2, components: [new TextDisplayBuilder().setContent(content)] };
}

export async function cmdSticker(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!store.getByChannelId(interaction.channelId)) {
		await interaction.reply({
			content: "LINEトークのチャンネルで実行してください。",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const pkg = await packageById(interaction.options.getString("package", true));
	await interaction.editReply(await gridView(pkg, 0));
}

export async function handleStickerComponent(
	interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
	const [action, packageId = "", pageText = "0", stickerId] = interaction.customId
		.slice(STICKER_PREFIX.length)
		.split(":");
	const page = Number(pageText) || 0;

	if (action === "cancel") {
		await interaction.update(textView("スタンプの送信をやめました。"));
		return;
	}

	if (action === "send" && stickerId) {
		// 二度押しで二重に送らないよう、先にボタンを消してから送る。
		await interaction.update(textView("送信中…"));
		const pkg = await packageById(packageId);
		const { animated } = await getPackageDetail(pkg.id);
		const result = await sendSticker(interaction.channelId, pkg, stickerId, animated);
		await interaction.editReply(textView(result.ok ? "スタンプを送信しました。" : result.reason));
		return;
	}

	// 所有一覧のキャッシュが切れていると取り直しで3秒の応答期限を超えることがある。先に受け付けておく。
	await interaction.deferUpdate();
	const pkg = await packageById(packageId);
	if (action === "grid") {
		await interaction.editReply(await gridView(pkg, page));
	} else if (action === "pick" && interaction.isStringSelectMenu()) {
		await interaction.editReply(await previewView(pkg, page, interaction.values[0]!));
	}
}

/** `/line sticker` の補完。所有しているパッケージを名前で絞り込む。 */
export async function stickerChoices(query: string): Promise<{ name: string; value: string }[]> {
	const packages = await listOwnedPackages(requireClient());
	const needle = query.trim().toLowerCase();
	return packages
		.filter((p) => !needle || p.name.toLowerCase().includes(needle))
		.slice(0, 25)
		.map((p) => ({ name: p.name.slice(0, 100), value: p.id }));
}
