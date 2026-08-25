import { OAuth2Scopes, PermissionFlagsBits, type Client } from "discord.js";

/**
 * このBotが実際に使う権限。招待URLはここから生成するので、
 * 権限表と実装がずれることがない。
 */
export const REQUIRED_PERMISSIONS = [
	PermissionFlagsBits.ViewChannel,
	PermissionFlagsBits.SendMessages,
	PermissionFlagsBits.ReadMessageHistory,
	PermissionFlagsBits.AttachFiles,
	PermissionFlagsBits.AddReactions,
	// トークごとのチャンネルを作る／自動で閉じる
	PermissionFlagsBits.ManageChannels,
	// 送信者ごとの名前とアイコンで投稿する
	PermissionFlagsBits.ManageWebhooks,
	// 自分の発言をWebhookで投稿し直すとき、元のメッセージを消す
	PermissionFlagsBits.ManageMessages,
];

export function inviteUrl(client: Client<true>): string {
	return client.generateInvite({
		scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
		permissions: REQUIRED_PERMISSIONS,
	});
}
