# DisLINE

LINEのトークをDiscordのチャンネルとして開き、そこで発言するとLINEに送信されるBotです。
自分のLINEアカウントを、自分が管理するDiscordサーバーに橋渡しします。

1インスタンスにつき1LINEアカウント。自分で立てて自分で使う想定です
（[公開Botにしない理由](#公開botにしない理由)）。

> [!WARNING]
> LINEの非公式クライアント [LINEJS](https://github.com/evex-dev/linejs) を使います。
> 自動化されたクライアントによるアクセスはLINEの利用規約に反し、アカウントが利用停止になる可能性があります。
> LINE側の仕様変更で予告なく動かなくなることもあります。自己責任で使ってください。

## 動作要件

- 自分が管理するDiscordサーバー。このBot専用に1つ作るのを勧めます
- Docker、またはNode.js 24以上

TypeScriptはNodeが直接実行し、SQLiteは組み込みの `node:sqlite` を使います。
ビルド段もネイティブモジュールのコンパイルもありません。

Dockerイメージはx86_64とarm64で動きます。Raspberry Piは64bit OSが必要です
（`node:24-alpine` に32bit ARM版がないため）。

## セットアップ

設定するのはDiscordのBotトークンだけです。アプリID・サーバーID・あなたのユーザーIDは起動時に判別します。

### 1. Discord Bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application
2. Bot タブ → Token を発行して控える
3. 同じタブの Privileged Gateway Intents で MESSAGE CONTENT INTENT を有効にする

3を忘れるとDiscordに接続を拒否され、`DisallowedIntents` で起動に失敗します。

招待URLはここでは要りません。起動するとログに出ます。

### 2. 起動する

自宅サーバーで常時動かすなら [自宅サーバーで動かす](#自宅サーバーで動かす)。手元で試すなら:

```sh
npm install
cp .env.example .env      # DISCORD_TOKEN を書く
npm start
```

### 3. サーバーに招待する

ログに招待URLが出ます。開いて自分のサーバーを選んでください。

```
[discord] まだサーバーに参加していません。次のURLを開いて、このBotを自分のサーバーに招待してください。

  https://discord.com/api/oauth2/authorize?client_id=...&permissions=...&scope=bot%20applications.commands

招待されたら自動で続きを行います。
```

このURLの権限はコードの定義から生成しているので、過不足が起きません。
招待するとスラッシュコマンドも自動で登録されます。

チャンネルはそのサーバーのメンバー全員から見えます。専用サーバーを勧めるのはそのためです。

複数のサーバーに招待した場合は対象を決められないので、起動時に候補を並べて止まります。
`.env` の `DISCORD_GUILD_ID` で指定してください。

### 4. LINEにログイン

`/line login` を実行すると、自分にだけ見えるQRコードが出ます。
LINEアプリのQRリーダーで読み取り、表示される本人確認番号が一致することを確かめてください。

続けて `/line setup` で `LINE` カテゴリと `#dis-line-log` チャンネルができます。

## 使い方

メッセージが届いたトークは自動でチャンネルになります。事前の登録は要りません。

同時に開くのは `MAX_OPEN_CHANNELS`（既定40）件まで。超えると最終活動が最も古いチャンネルから閉じ、
`#dis-line-log` に記録が残ります。次にそのトークにメッセージが届けば同じ名前で開き直します。
残したいトークは、たまに発言するか `/line open` を打てば最後尾に回ります。

### メッセージの種類

| LINE | Discordでの見え方 |
|---|---|
| テキスト | そのまま（送信者の名前とアイコン付き） |
| 画像・動画・音声・ファイル | 添付ファイルとして再アップロード |
| スタンプ | 画像として表示（動くスタンプはAPNGのまま動く） |
| 位置情報・連絡先・リッチメッセージ | 種別のラベルだけ |

`MAX_UPLOAD_MB`（既定8）を超えるものは添付されず、種別とサイズが出ます。

Discordからはテキストと添付ファイルを送れます。
DiscordのスタンプはLINEのスタンプIDに対応付けられないので送れません。

### 返信

LINEの返信はDiscordでは引用行になります。引用部分は元メッセージへのジャンプリンクです。
Webhookからはネイティブの返信を使えないため、この形にしています。

Discordで返信して送ると、LINE側でも返信として届きます。

### 自分の発言はWebhookで投稿し直される

Discordで発言すると、LINEへ送ったあとBotが同じ内容をWebhookで投稿し直し、元のメッセージを消します。
一瞬ちらつきます。

Botが編集できるのは自分がWebhookで投稿したメッセージだけなので、こうしておかないと
送信取り消しのときに本文を差し替えられません。ついでに自分の発言もLINEの表示名とアイコンで並びます。

LINEへの送信が失敗したときは投稿し直しません。元のメッセージが ❌ 付きで残ります。

### 送信取り消し

LINEで取り消すと、Discord側の本文が `🚫 送信が取り消されました` に変わります。

Discordから取り消すときは、メッセージを右クリック（スマホは長押し）→ アプリ → 「LINEで取り消す」。
LINE側で取り消され、Discordでも同じ位置が置き換わります。

どちらも削除ではなく差し替えなので、会話の並びは崩れません。
LINE側の取り消しに失敗したとき（送信取り消しには時間制限があります）はDiscord側も変えません。
片方だけ消えて食い違わないようにしてあります。

メッセージを普通に削除してもLINE側で取り消されますが、削除したものは復元できないので
Discordからは消えたままになります。位置を残したいときは右クリックのほうを使ってください。

### 既読

既読が付くのは次の2つのときだけです。

- そのチャンネルで発言したとき。トークの未読をまとめて既読にします
- 転送されたメッセージにDiscordでリアクションを付けたとき。そのメッセージまでを既読にします

受信しただけでは付きません。寝ている間に届いたメッセージに勝手に既読が付くことはありません。

### コマンド

| コマンド | 説明 |
|---|---|
| `/line login` | QRコードでLINEにログイン |
| `/line logout` | ローカルのセッションを破棄 |
| `/line status` | ログイン状態と展開中のチャンネル一覧 |
| `/line setup` | カテゴリとログチャンネルを作成 |
| `/line list [query]` | グループ・友だちの一覧 |
| `/line open <chat>` | まだ届いていないトークを先に開く（名前で補完が効く） |
| `/line close` | そのチャンネルを閉じる（トークは消えない。開き直せる） |
| `/line sync` | グループ・友だち一覧を取り直す |

メッセージを右クリック → アプリ → 「LINEで取り消す」も使えます。

## 自宅サーバーで動かす

Docker Composeで常時稼働させます。サーバー側にNodeは要りません。

```sh
git clone https://github.com/asutarisucu/DisLINE.git dis-line && cd dis-line
cp .env.example .env      # DISCORD_TOKEN を書く
docker compose up -d --build
docker compose logs dis-line          # 招待URLが出る
```

あとは招待して `/line login` → `/line setup`。

### 更新

```sh
git pull
docker compose up -d --build
```

`--build` を省くとcomposeが古いイメージを使い回し、変更が反映されないまま起動します。
スラッシュコマンドは定義が変わったときだけ登録し直すので、手作業は要りません。

### 稼働の確認

```sh
docker compose ps                                        # STATUS が healthy
docker compose logs -f --tail 50
docker compose exec dis-line cat /app/data/health.json   # state: ok / waiting-login
```

linejsのポーリングは、失敗してもプロセスが生きたまま橋渡しだけ止まることがあります。
再起動ポリシーでは終了していないものを拾えないので、5分おきにLINEへ疎通確認し、
3回続けて失敗したら自分から終了して再起動に任せます。
`health.json` が15分以上更新されなければ、コンテナがunhealthyになります。

### データとバックアップ

`dis-line-data` ボリュームにLINEの認証トークンとE2EE鍵が入っています。失うと `/line login` からやり直しです。

```sh
# バックアップ
docker compose stop
docker run --rm -v dis-line-data:/src -v "$PWD:/out" alpine \
  tar czf /out/dis-line-backup-$(date +%F).tar.gz -C /src .
docker compose start

# 復元
docker compose stop
docker run --rm -v dis-line-data:/dst -v "$PWD:/in" alpine \
  sh -c 'rm -rf /dst/* && tar xzf /in/dis-line-backup-YYYY-MM-DD.tar.gz -C /dst && chown -R 1000:1000 /dst'
docker compose start
```

復元は現在のセッションを消してから展開します。**ファイル名を間違えると今動いているセッションが消えます。**

バインドマウント（`./data:/app/data`）にすればファイルを直接触れますが、
SQLiteがPOSIXのファイルロックを要求するので置き場所を選びます。

| 置き場所 | |
|---|---|
| 名前付きボリューム（既定） | ○ |
| Linuxのローカルディスクへのバインドマウント | ○ 先に `mkdir -p data` |
| Docker Desktop（Windows/macOS）のバインドマウント | ✗ `disk I/O error` で起動できない |
| NFS / SMB / NAS 越し | ✗ 同上、またはデータベース破損 |

ログは `json-file` ドライバで10MB × 5世代に制限しています。

## うまく動かないとき

| 症状 | 対処 |
|---|---|
| `DisallowedIntents` で起動しない | MESSAGE CONTENT INTENT が無効。Developer Portal → Bot → Privileged Gateway Intents でONにして保存し、起動し直す |
| `TokenInvalid` で起動しない | `.env` の `DISCORD_TOKEN` が違う。Developer Portal → Bot → Reset Token で再発行する |
| `env file ... not found` | `.env` が無い。`cp .env.example .env` してからトークンを書く |
| `Botが N 個のサーバーに参加しています` | 対象を決められない。`.env` の `DISCORD_GUILD_ID` にサーバーIDを書く |
| `disk I/O error`（SQLite） | `data/` のバインドマウント先がDocker DesktopかNAS越し。既定の名前付きボリュームを使う |
| `データ置き場 ... に書き込めません` | バインドマウント元がroot所有。`mkdir -p data && sudo chown -R 1000:1000 data` |
| スラッシュコマンドが出てこない | 招待時に `applications.commands` スコープが付いていない。ログの招待URLで招待し直す |
| 送信者名が `不明なユーザー (u1234abcd)` になる | LINE側で相手の情報を取得できていない。コンソールの `[line] … 表示名を取得できませんでした` に理由が出る |
| 同じメッセージがDiscordに2回出る | 別の場所で同じLINEセッションのインスタンスが動いていないか確認する |

## 制限

運ばれないもの:

- LINEのリアクション。Discordでリアクションを付けると既読が付くだけで、LINE側には反映されません
- LINE絵文字（本文に埋め込まれるsticon）。テキストの一部として置換前の文字のまま出ます
- OpenChat（Square）

Discord側の制限:

- 1カテゴリ50チャンネル、1サーバー500チャンネル。50を超えると `LINE-2` を自動で作りますが、
  `MAX_OPEN_CHANNELS` は500より十分小さくしてください
- チャンネル名の変更は10分に2回まで。LINE側でトーク名が変わってもチャンネル名は追従しません。
  `/line close` で閉じれば次の受信時に新しい名前で作り直します
- 公式アカウントや広告も自動でチャンネル化されます。自動クローズで押し出されますが、
  うるさければLINE側でブロックしてください

## セキュリティ

- `data/` にLINEの認証トークンとE2EE鍵が平文で入ります。`.gitignore` / `.dockerignore` 済みですが、
  共有・コミットしないでください
- 送信失敗時の診断ログにLINEのメッセージ本文が出ることがあります（`bridge.ts` の警告）。
  ログの扱いは `data/` と同程度に
- `/line logout` が消すのはローカルのセッションだけです。LINE側の端末登録はLINEアプリの
  「ログイン中の端末」から削除してください
- `npm audit` は間接依存の `thrift` にhigh 2件を報告します。thrift パッケージのHTTPサーバ・
  静的配信機能に対する指摘で、このBotはその機能を使っていません。linejsが固定している依存なので
  こちら側では解消できません

## 公開Botにしない理由

ブリッジは常時接続していないと成立せず、接続している間は認証情報がメモリ上に平文で必要です。
保存時に暗号化しても守れるのはディスクを盗まれた場合だけで、稼働中のサーバーが侵害されれば
全利用者分のLINEセッションが同時に取られます。

LINEアカウントの掌握は「メッセージが読める」では終わらず、友だち全員へのなりすましまで届きます。
被害範囲が利用者数 × その人の人間関係になる、というのが公開Botで引き受けることです。
実装で軽くできる問題ではなく、預かるのをやめる以外に消す方法がありません。

ほかにも、DiscordのMessage Content Intentの審査、同一IPからの多数アカウント接続、
個人情報保護法上の義務といった壁があります。

## 開発

```sh
npm run typecheck
npm test
```

```
src/
  config.ts            環境変数
  runtime.ts           起動時に確定する値（アプリID・対象サーバー・所有者）
  store.ts             SQLite（トーク⇔チャンネル対応、メッセージ対応表）
  echo.ts              自分の送信がpollingで返ってきたときの抑止
  health.ts            疎通の見張り
  index.ts             エントリ。設定の判別とイベント配線
  bridge.ts            LINE→Discord / Discord→LINE の変換
  line/
    session.ts         QRログイン・トークン永続化・再開
    directory.ts       グループ/友だち一覧のキャッシュ
    media.ts           画像/スタンプ/ファイルの取得と種別判定
    util.ts            mid判定・chatId解決・表示名/アイコン
  discord/
    channels.ts        カテゴリ/チャンネル/Webhookの管理
    commands.ts        スラッシュコマンドと右クリックメニュー
    permissions.ts     必要な権限の定義と招待URLの生成
```

## ライセンス

MIT（[LICENSE](LICENSE)）。依存している [LINEJS](https://github.com/evex-dev/linejs) もMITです。
