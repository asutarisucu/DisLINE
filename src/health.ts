import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";
import { getClient } from "./line/session.ts";

/**
 * 無人稼働の見張り。
 *
 * linejs のポーリングループは内部で例外を捕まえないため、死んでもプロセスは生き続け、
 * 橋渡しだけが静かに止まる。この状態は再起動ポリシーでは救えない（終了していないので）。
 * 定期的にLINEへ疎通を確認し、復旧しなければ自分から終了して再起動に任せる。
 */
const PROBE_INTERVAL_MS = 5 * 60 * 1000;
const FAILURES_BEFORE_EXIT = 3;

/** コンテナのヘルスチェックはこのファイルの更新時刻を見る。中身は人が読むためのもの。 */
const healthFile = resolve(config.dataDir, "health.json");

type State = "starting" | "waiting-login" | "ok" | "failing";

let consecutiveFailures = 0;

function record(state: State, detail?: string): void {
	try {
		writeFileSync(
			healthFile,
			`${JSON.stringify({ state, detail, at: new Date().toISOString() }, null, 2)}\n`,
		);
	} catch (error) {
		console.error("[health] 状態ファイルを書けませんでした:", error);
	}
}

async function probe(): Promise<void> {
	const client = getClient();
	if (!client) {
		// 未ログインは異常ではない。/line login を待っている状態。
		consecutiveFailures = 0;
		record("waiting-login");
		return;
	}

	try {
		await client.base.talk.noop();
		consecutiveFailures = 0;
		record("ok");
	} catch (error) {
		consecutiveFailures += 1;
		record("failing", `${consecutiveFailures}/${FAILURES_BEFORE_EXIT}: ${String(error).slice(0, 300)}`);
		console.error(
			`[health] LINEへの疎通に失敗しました (${consecutiveFailures}/${FAILURES_BEFORE_EXIT}):`,
			error,
		);
		if (consecutiveFailures >= FAILURES_BEFORE_EXIT) {
			console.error("[health] 復旧しないため終了します。再起動して保存済みトークンで再開します。");
			process.exit(1);
		}
	}
}

export function startWatchdog(): void {
	record("starting");
	void probe();
	// unref しない。この間隔がプロセスを起こし続けることで、疎通確認が確実に回る。
	setInterval(() => void probe(), PROBE_INTERVAL_MS);
}
