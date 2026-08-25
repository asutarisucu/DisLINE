import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts は import 時に環境変数を要求する。テスト用の値とデータ置き場を先に用意する。
process.env.DISCORD_TOKEN ??= "test-token";
process.env.DISCORD_CLIENT_ID ??= "1";
process.env.DISCORD_GUILD_ID ??= "2";
process.env.OWNER_ID ??= "3";
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "disline-test-"));

const { midKind, resolveChatId, contentTypeName, placeholderFor, profileImageUrl, IdentityCache } =
	await import("../src/line/util.ts");
const { sanitizeChannelName, sanitizeWebhookName } = await import("../src/discord/channels.ts");
const { store } = await import("../src/store.ts");
const { markPending, cancelPending, consumePending, pendingCount } = await import("../src/echo.ts");
const { stickerUrl, hasDownloadableContent, isSticker, objTypeFor } = await import("../src/line/media.ts");

type FakeMessage = { raw: { to: string; from: string }; isMyMessage: boolean };
const asMessage = (m: FakeMessage) => m as unknown as Parameters<typeof resolveChatId>[0];

const ME = "u0000000000000000000000000000me";
const FRIEND = "u1111111111111111111111111111aa";
const GROUP = "c2222222222222222222222222222bb";
const ROOM = "r3333333333333333333333333333cc";

test("midKind は mid の接頭辞から種別を返す", () => {
	assert.equal(midKind(FRIEND), "USER");
	assert.equal(midKind(GROUP), "GROUP");
	assert.equal(midKind(ROOM), "ROOM");
	assert.equal(midKind("x999"), "UNKNOWN");
	assert.equal(midKind(""), "UNKNOWN");
});

test("グループの chatId は送受信どちらでも to になる", () => {
	assert.equal(resolveChatId(asMessage({ raw: { to: GROUP, from: FRIEND }, isMyMessage: false })), GROUP);
	assert.equal(resolveChatId(asMessage({ raw: { to: GROUP, from: ME }, isMyMessage: true })), GROUP);
});

test("ルームもグループと同じく to が chatId", () => {
	assert.equal(resolveChatId(asMessage({ raw: { to: ROOM, from: FRIEND }, isMyMessage: false })), ROOM);
});

test("1:1で受信したメッセージの chatId は to(=自分) ではなく from(=相手)", () => {
	// ここを to にすると自分自身にメッセージを送り返し続けることになる。
	const received = asMessage({ raw: { to: ME, from: FRIEND }, isMyMessage: false });
	assert.equal(resolveChatId(received), FRIEND);
});

test("1:1で自分が送ったメッセージの chatId は to(=相手)", () => {
	const sent = asMessage({ raw: { to: FRIEND, from: ME }, isMyMessage: true });
	assert.equal(resolveChatId(sent), FRIEND);
});

test("ContentType は数値でも文字列でも名前に揃う", () => {
	assert.equal(contentTypeName(0), "NONE");
	assert.equal(contentTypeName(7), "STICKER");
	assert.equal(contentTypeName("IMAGE"), "IMAGE");
	assert.equal(contentTypeName(undefined), "NONE");
	assert.equal(contentTypeName(999), "UNKNOWN(999)");
	assert.equal(placeholderFor(7), "🎨 スタンプ");
	assert.equal(placeholderFor("IMAGE"), "🖼️ 画像");
});

test("スタンプURLは静止と動くもので出し分ける", () => {
	// linejs の getStickerURL() は contentType の文字列比較で弾くため数値経路で使えない。自前で組む。
	assert.equal(
		stickerUrl({ STKID: "52002734" }),
		"https://stickershop.line-scdn.net/stickershop/v1/sticker/52002734/android/sticker.png",
	);
	assert.equal(
		stickerUrl({ STKID: "52002734", STKOPT: "A" }),
		"https://stickershop.line-scdn.net/stickershop/v1/sticker/52002734/android/sticker_animation.png",
	);
	assert.equal(stickerUrl({}), null);
	assert.equal(stickerUrl(undefined), null);
});

test("中身を運べる種別の判定は数値でも文字列でも効く", () => {
	assert.equal(hasDownloadableContent(1), true); // IMAGE
	assert.equal(hasDownloadableContent("FILE"), true);
	assert.equal(hasDownloadableContent(7), false); // STICKER は別経路
	assert.equal(hasDownloadableContent(0), false); // NONE
	assert.equal(isSticker(7), true);
	assert.equal(isSticker("STICKER"), true);
	assert.equal(isSticker(1), false);
});

test("Discordの添付はMIMEからLINEの種別に振り分けられる", () => {
	assert.equal(objTypeFor("image/png"), "image");
	assert.equal(objTypeFor("image/gif"), "gif");
	assert.equal(objTypeFor("video/mp4"), "video");
	assert.equal(objTypeFor("audio/mpeg"), "audio");
	assert.equal(objTypeFor("application/pdf"), "file");
	assert.equal(objTypeFor(null), "file");
});

test("picturePath は先頭のスラッシュ有無を問わずURLになる", () => {
	assert.equal(profileImageUrl("/0hAbCd"), "https://profile.line-scdn.net/0hAbCd");
	assert.equal(profileImageUrl("0hAbCd"), "https://profile.line-scdn.net/0hAbCd");
	assert.equal(profileImageUrl(""), undefined);
	assert.equal(profileImageUrl(undefined), undefined);
});

test("チャンネル名は日本語を保ち、空にならない", () => {
	assert.equal(sanitizeChannelName("田中 太郎"), "田中-太郎");
	assert.equal(sanitizeChannelName("Team #general"), "team-general");
	assert.equal(sanitizeChannelName("###"), "line-chat");
	assert.equal(sanitizeChannelName("   "), "line-chat");
	assert.ok(sanitizeChannelName("あ".repeat(200)).length <= 90);
});

test("Webhook名から discord を取り除き、空なら既定名にする", () => {
	// "discord" を含む username は Discord 側に拒否され、送信が丸ごと失敗する。
	assert.equal(sanitizeWebhookName("Discord公式"), "disc0rd公式");
	assert.equal(sanitizeWebhookName("DISCORD"), "disc0rd");
	assert.equal(sanitizeWebhookName("   "), "LINE");
	assert.ok(sanitizeWebhookName("あ".repeat(200)).length <= 80);
});

// IdentityCache が触るのは base.profile / relation.getContactsV3 / talk.getContactsV2 /
// talk.getContact / getChat だけなので、その形だけ持つ偽クライアントで足りる。
function fakeClient(overrides: {
	v3?: () => Promise<unknown>;
	v2?: () => Promise<unknown>;
	contact?: () => Promise<unknown>;
}) {
	const reject = () => Promise.reject(new Error("API method not capable"));
	return {
		base: {
			profile: { mid: ME, displayName: "わたし", picturePath: "/0hMe" },
			relation: { getContactsV3: overrides.v3 ?? reject },
			talk: { getContactsV2: overrides.v2 ?? reject, getContact: overrides.contact ?? reject },
		},
		getChat: () => Promise.reject(new Error("not a chat")),
	} as unknown as ConstructorParameters<typeof IdentityCache>[0];
}

test("getContactsV3 が使えれば profileName を表示名にする", async () => {
	const cache = new IdentityCache(
		fakeClient({
			v3: () =>
				Promise.resolve({
					responses: [{ targetProfileDetail: { profileName: "山田", picturePath: "/0hYamada" } }],
				}),
		}),
	);
	assert.deepEqual(await cache.get(FRIEND), {
		name: "山田",
		avatar: "https://profile.line-scdn.net/0hYamada",
	});
});

test("getContactsV3 が落ちても getContactsV2 で表示名を取れる", async () => {
	// linejs の Client.getUser() は V3 一本でフォールバックが無く、ここで mid の断片に化けていた。
	const cache = new IdentityCache(
		fakeClient({
			v2: () =>
				Promise.resolve({
					contacts: { [FRIEND]: { contact: { displayName: "鈴木", picturePath: "/0hSuzuki" } } },
				}),
		}),
	);
	assert.deepEqual(await cache.get(FRIEND), {
		name: "鈴木",
		avatar: "https://profile.line-scdn.net/0hSuzuki",
	});
});

test("V3 が空配列を返す場合もフォールバックが働く", async () => {
	const cache = new IdentityCache(
		fakeClient({
			v3: () => Promise.resolve({ responses: [] }),
			contact: () => Promise.resolve({ displayName: "田中", picturePath: "/0hTanaka" }),
		}),
	);
	assert.equal((await cache.get(FRIEND)).name, "田中");
});

test("LINEで付けた表示名の上書きがあればそちらを優先する", async () => {
	const cache = new IdentityCache(
		fakeClient({
			v2: () =>
				Promise.resolve({
					contacts: { [FRIEND]: { contact: { displayName: "本名", displayNameOverridden: "あだ名" } } },
				}),
		}),
	);
	assert.equal((await cache.get(FRIEND)).name, "あだ名");
});

test("全部失敗したときは ID そのものではなく不明である旨を出す", async () => {
	const cache = new IdentityCache(fakeClient({}));
	const identity = await cache.get(FRIEND);
	assert.match(identity.name, /^不明なユーザー \(/);
	assert.equal(identity.avatar, undefined);
});

test("自分自身はRPCを叩かずプロフィールから解決する", async () => {
	const cache = new IdentityCache(fakeClient({}));
	assert.deepEqual(await cache.get(ME), { name: "わたし", avatar: "https://profile.line-scdn.net/0hMe" });
});

test("自分が送ったメッセージIDは記録され、二重投稿の判定に使える", () => {
	assert.equal(store.wasSentByUs("m-not-sent"), false);
	store.markSent("m-sent");
	assert.equal(store.wasSentByUs("m-sent"), true);
});

test("メッセージIDは数値で来ても文字列で来ても同じものとして扱う", () => {
	// LINEのIDはi64。送信応答とpollingで型が揃う保証が無い。
	store.markSent(1234567890123);
	assert.equal(store.wasSentByUs("1234567890123"), true);
	store.markSent("9876543210");
	assert.equal(store.wasSentByUs(9876543210), true);
});

test("IDが空・undefinedのときは記録も照合もしない（誤って全部抑止しない）", () => {
	store.markSent(undefined);
	store.markSent("");
	assert.equal(store.wasSentByUs(undefined), false);
	assert.equal(store.wasSentByUs(""), false);
});

test("転送済みのLINEメッセージは再配信されても二重投稿しない", () => {
	assert.equal(store.wasPostedToDiscord("line-dup"), false);
	store.linkMessage("d-dup", "line-dup", GROUP);
	assert.equal(store.wasPostedToDiscord("line-dup"), true);
});

test("送信前に登録した本文は、応答より先にpollingが来ても抑止される", () => {
	// IDでの照合は送信レスポンスが先に返ることが前提で、それは保証されない。
	assert.equal(consumePending(GROUP, "やあ"), false);
	markPending(GROUP, "やあ");
	assert.equal(consumePending(GROUP, "やあ"), true);
	// 消費済みなので2回目は通す
	assert.equal(consumePending(GROUP, "やあ"), false);
});

test("同じ本文をDiscordとLINEアプリから1回ずつ送ったら、抑止されるのは1通だけ", () => {
	markPending(GROUP, "ok");
	assert.equal(consumePending(GROUP, "ok"), true); // Discord経由の分
	assert.equal(consumePending(GROUP, "ok"), false); // LINEアプリからの分は表示する
});

test("トークが違えば抑止されない", () => {
	markPending(GROUP, "共通の文言");
	assert.equal(consumePending(FRIEND, "共通の文言"), false);
	assert.equal(consumePending(GROUP, "共通の文言"), true);
});

test("送信に失敗したら登録を取り消し、相手の同じ本文を誤って消さない", () => {
	markPending(GROUP, "届かなかった");
	cancelPending(GROUP, "届かなかった");
	assert.equal(consumePending(GROUP, "届かなかった"), false);
	assert.equal(pendingCount(), 0);
});

test("チャンネルの割り当てと解除でマッピングが往復する", () => {
	store.rememberChat(GROUP, "テストグループ");
	assert.equal(store.getByChatId(GROUP)?.channel_id, null);

	store.attachChannel(GROUP, "chan-1", "wh-1", "wh-token");
	assert.equal(store.getByChannelId("chan-1")?.chat_id, GROUP);
	assert.equal(store.openChats().length, 1);

	// 名前を更新してもチャンネルの紐付けは維持される。
	store.rememberChat(GROUP, "改名後グループ");
	assert.equal(store.getByChatId(GROUP)?.channel_id, "chan-1");
	assert.equal(store.getByChatId(GROUP)?.name, "改名後グループ");

	store.detachChannel(GROUP);
	assert.equal(store.getByChannelId("chan-1"), undefined);
	assert.equal(store.openChats().length, 0);
	assert.equal(store.getByChatId(GROUP)?.name, "改名後グループ");
});

test("自動クローズの対象は最終活動が古い順で、対象トーク自身は除外される", () => {
	const ids = ["c-old", "c-mid", "c-new", "c-self"];
	ids.forEach((id, i) => {
		store.rememberChat(id, `chat-${id}`);
		store.attachChannel(id, `ch-${id}`, `wh-${id}`, "token");
		// last_active を明示して順序を固定する
		store.touch(id, 1000 + i);
	});

	const victims = store.evictionCandidates("c-self", 2).map((m) => m.chat_id);
	assert.deepEqual(victims, ["c-old", "c-mid"]);
	assert.equal(store.openChannelCount(), 4);

	// 触れば最後尾に回り、次の候補から外れる
	store.touch("c-old", 9999);
	assert.deepEqual(store.evictionCandidates("c-self", 1).map((m) => m.chat_id), ["c-mid"]);

	for (const id of ids) store.detachChannel(id);
});

test("Discordメッセージから元のLINEメッセージを引ける（リアクション既読用）", () => {
	assert.equal(store.getLink("d-unknown"), undefined);

	store.linkMessage("d-1", "line-1", GROUP);
	const link = store.getLink("d-1");
	assert.equal(link?.line_id, "line-1");
	assert.equal(link?.chat_id, GROUP);
});

test("長文が分割されても、全部が同じLINEメッセージに紐づく（取消で全部消す）", () => {
	store.linkMessage("d-part1", "line-long", GROUP, { preview: "長い本文" });
	store.linkMessage("d-part2", "line-long", GROUP, { preview: "長い本文" });
	const links = store.getLinksByLineId("line-long");
	assert.deepEqual(links.map((l) => l.discord_id), ["d-part1", "d-part2"]);
});

test("自分の送信だけが outgoing として記録される", () => {
	store.linkMessage("d-mine", "line-mine", GROUP, { outgoing: true, preview: "自分の発言" });
	store.linkMessage("d-theirs", "line-theirs", GROUP, { preview: "相手の発言" });
	assert.equal(store.getLink("d-mine")?.outgoing, 1);
	assert.equal(store.getLink("d-theirs")?.outgoing, 0);
});

test("取消を反映したら対応表から消す（Discord側の削除検知が誤爆しない）", () => {
	// 取消の差し替え/削除が messageDelete を誘発しても、対応表に無ければ何もしない。
	store.linkMessage("d-retract", "line-retract", GROUP, { outgoing: true });
	assert.ok(store.getLink("d-retract"));
	store.deleteLink("d-retract");
	assert.equal(store.getLink("d-retract"), undefined);
	assert.deepEqual(store.getLinksByLineId("line-retract"), []);
});

test("返信の引用に出す本文は保存され、長すぎれば切り詰められる", () => {
	store.linkMessage("d-quote", "line-quote", GROUP, { preview: "あ".repeat(500) });
	const preview = store.getLink("d-quote")?.preview ?? "";
	assert.ok(preview.length <= 200, `preview が長すぎます: ${preview.length}`);
});

test("最後に受信したLINEメッセージIDが保持される（発言時の既読位置）", () => {
	store.rememberChat(FRIEND, "友だち");
	assert.equal(store.getByChatId(FRIEND)?.last_line_message_id, null);

	store.setLastLineMessage(FRIEND, "line-42");
	assert.equal(store.getByChatId(FRIEND)?.last_line_message_id, "line-42");
});
