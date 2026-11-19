import { TalkMessage, type Client } from "@evex/linejs";
import type * as LINETypes from "@evex/linejs-types";
import { midKind } from "./util.ts";

const PAGE_SIZE = 50;
/** 1トークで遡るページ数の上限。時間で止まらないトークがあっても取得が終わるようにする。 */
const MAX_PAGES_PER_CHAT = 20;

type TalkApi = Pick<Client["base"]["talk"], "getMessageBoxes" | "getPreviousMessagesV2WithRequest">;

/**
 * since 以降・until より前に届いたトークのメッセージを、古い順に返す（復号前）。
 *
 * ログインし直すと受信は新しいセッションの位置から始まるので、
 * ログインしていなかった間のメッセージは polling では届かない。履歴から取り直す。
 */
export async function collectRawMessages(talk: TalkApi, since: number, until: number): Promise<LINETypes.Message[]> {
	const byId = new Map<string, LINETypes.Message>();
	for (const box of await listMessageBoxes(talk)) {
		const kind = midKind(box.id);
		if (kind !== "USER" && kind !== "GROUP" && kind !== "ROOM") continue;
		if (!box.lastDeliveredMessageId || Number(box.lastDeliveredMessageId.deliveredTime) < since) continue;

		let end: LINETypes.MessageBoxV2MessageId = box.lastDeliveredMessageId;
		for (let page = 0; page < MAX_PAGES_PER_CHAT; page++) {
			// 新しい順に返り、終端に指定したメッセージ自身も含む。
			const messages = await talk.getPreviousMessagesV2WithRequest({
				request: { messageBoxId: box.id, endMessageId: end, messagesCount: PAGE_SIZE },
			});
			for (const message of messages) {
				const at = Number(message.createdTime);
				if (at >= since && at < until) byId.set(String(message.id), message);
			}
			const oldest = messages.at(-1);
			if (!oldest || messages.length < PAGE_SIZE || Number(oldest.createdTime) < since) break;
			// メッセージIDは18桁あり、Number にすると桁が落ちる。
			end = { messageId: BigInt(oldest.id), deliveredTime: oldest.deliveredTime };
		}
	}
	return [...byId.values()].sort(
		(a, b) => Number(a.createdTime) - Number(b.createdTime) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
	);
}

async function listMessageBoxes(talk: TalkApi): Promise<LINETypes.ExtendedMessageBox[]> {
	const boxes = new Map<string, LINETypes.ExtendedMessageBox>();
	let request: Partial<LINETypes.MessageBoxListRequest> = {};
	for (let page = 0; page < 50; page++) {
		const result = await talk.getMessageBoxes({ messageBoxListRequest: request });
		for (const box of result.messageBoxes) boxes.set(box.id, box);
		const last = result.messageBoxes.at(-1);
		if (!result.hasNext || !last) break;
		request = { minChatId: last.id };
	}
	return [...boxes.values()];
}

/** 取り直したメッセージを復号する。復号できなかったものは数だけ返す。 */
export async function fetchMessagesBetween(
	client: Client,
	since: number,
	until: number,
): Promise<{ messages: TalkMessage[]; undecryptable: number }> {
	const messages: TalkMessage[] = [];
	let undecryptable = 0;
	for (const raw of await collectRawMessages(client.base.talk, since, until)) {
		try {
			messages.push(await TalkMessage.fromRawTalk(raw, client));
		} catch (error) {
			undecryptable++;
			console.error(`[line] 履歴のメッセージを復号できませんでした (${raw.id}):`, error);
		}
	}
	return { messages, undecryptable };
}
