import { loginWithAuthToken, loginWithQR, type Client } from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";
import { config } from "../config.ts";
import { store } from "../store.ts";

const AUTH_TOKEN_KEY = "line.authToken";

/** E2EE鍵やrefreshTokenはここに入る。authToken だけ持っていても再開できない。 */
const storage = new FileStorage(config.lineStoragePath);

let client: Client | null = null;
let tokenWatcher: NodeJS.Timeout | null = null;

export function getClient(): Client | null {
	return client;
}

export function requireClient(): Client {
	if (!client) throw new Error("LINEにログインしていません。`/line login` を実行してください。");
	return client;
}

/**
 * authToken はライブラリ内部で更新されることがある。
 * 更新後の値を保存し損ねると、次回起動時に失効済みトークンで再開しようとして失敗する。
 */
function persistToken(): void {
	if (!client) return;
	const current = client.authToken;
	if (current && current !== store.getMeta(AUTH_TOKEN_KEY)) {
		store.setMeta(AUTH_TOKEN_KEY, current);
	}
}

function afterLogin(newClient: Client): Client {
	client = newClient;
	persistToken();
	tokenWatcher ??= setInterval(persistToken, 60_000);
	tokenWatcher.unref?.();
	return newClient;
}

/** 保存済みトークンでの再開を試みる。失敗しても投げず false を返す。 */
export async function resume(): Promise<boolean> {
	const token = store.getMeta(AUTH_TOKEN_KEY);
	if (!token) return false;
	try {
		afterLogin(await loginWithAuthToken(token, { device: config.device, storage }));
		return true;
	} catch (error) {
		console.error("[line] 保存済みトークンでの再開に失敗しました:", error);
		return false;
	}
}

export interface QrLoginHandlers {
	onQrUrl(url: string): Promise<void> | void;
	onPincode(pin: string): Promise<void> | void;
}

export async function loginByQr(handlers: QrLoginHandlers): Promise<Client> {
	const logged = await loginWithQR(
		{ onReceiveQRUrl: handlers.onQrUrl, onPincodeRequest: handlers.onPincode },
		{ device: config.device, storage },
	);
	return afterLogin(logged);
}

/**
 * ローカルのセッションを破棄する。LINE側の端末登録は解除されないので、
 * 完全に切りたい場合はLINEアプリの「ログイン中の端末」から削除する必要がある。
 */
export async function logout(): Promise<void> {
	client = null;
	store.deleteMeta(AUTH_TOKEN_KEY);
	await storage.clear();
	if (tokenWatcher) {
		clearInterval(tokenWatcher);
		tokenWatcher = null;
	}
}
