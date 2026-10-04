import type { Client } from "@evex/linejs";
import { stickerUrl } from "./media.ts";

export interface StickerPackage {
	id: string;
	name: string;
	/** 送信時の STKVER。 */
	version: string;
}

export interface PackageDetail {
	stickerIds: string[];
	animated: boolean;
}

const OWNED_TTL_MS = 10 * 60_000;
const PAGE_SIZE = 100;

let owned: { at: number; packages: StickerPackage[] } | null = null;
const details = new Map<string, PackageDetail>();

/**
 * 所有しているスタンプのパッケージ一覧。無料・既定のスタンプも含む。
 *
 * linejs 3.2.1 の ShopService は `client.base` に付いておらず、パッケージからもエクスポートされていない。
 * ShopService.getOwnedProductSummaries と同じリクエスト（/TSHOP4、compact protocol）を直接組み立てる。
 * 引数の並びは CHRLINE の ShopService.getOwnedProductSummaries と一致する。
 *
 * 戻り値は linejs-types の定義が欠けていて（`success` の型名 `YN0_Ob1_N0` が定義に無い）、
 * フィールド番号のまま返ってくる。中身は ProductSummaryList なので、その定義で名前を付け直してから読む。
 */
export async function listOwnedPackages(client: Client, refresh = false): Promise<StickerPackage[]> {
	if (!refresh && owned && Date.now() - owned.at < OWNED_TTL_MS) return owned.packages;

	const packages: StickerPackage[] = [];
	for (let offset = 0; ; offset += PAGE_SIZE) {
		const raw = await client.base.request.request(
			[
				[11, 2, "stickershop"],
				[8, 3, offset],
				[8, 4, PAGE_SIZE],
				[12, 5, [[11, 1, "ja"], [11, 2, "JP"]]],
			],
			"getOwnedProductSummaries",
			4,
			true,
			"/TSHOP4",
		);
		const list = client.base.thrift.rename_thrift("ProductSummaryList", raw) as {
			productList?: { id?: string; name?: string; latestVersion?: number | bigint }[];
			totalSize?: number;
		};
		const page = list.productList ?? [];
		for (const product of page) {
			if (!product.id) continue;
			packages.push({
				id: String(product.id),
				name: product.name || `スタンプ ${product.id}`,
				version: String(product.latestVersion ?? 1),
			});
		}
		if (page.length < PAGE_SIZE || packages.length >= (list.totalSize ?? 0)) break;
	}

	owned = { at: Date.now(), packages };
	return packages;
}

/** パッケージに入っているスタンプのID。公開CDNのメタ情報から取るので認証は要らない。 */
export async function getPackageDetail(packageId: string): Promise<PackageDetail> {
	const cached = details.get(packageId);
	if (cached) return cached;

	const url = `https://stickershop.line-scdn.net/stickershop/v1/product/${encodeURIComponent(packageId)}/android/productInfo.meta`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`スタンプ情報の取得に失敗しました (HTTP ${response.status})`);
	const meta = (await response.json()) as { stickers?: { id: number }[]; hasAnimation?: boolean };

	const detail = {
		stickerIds: (meta.stickers ?? []).map((s) => String(s.id)),
		animated: meta.hasAnimation === true,
	};
	details.set(packageId, detail);
	return detail;
}

export function previewUrl(stickerId: string, animated: boolean): string {
	return stickerUrl({ STKID: stickerId, ...(animated ? { STKOPT: "A" } : {}) })!;
}
