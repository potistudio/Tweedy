# Tweedy

X (Twitter) のツイートを **メディアごと IndexedDB に保存** し、フォルダとタグで整理・一覧できる Chrome 拡張機能 (Manifest V3)。X 標準のブックマークの代替として使う。

## インストール

1. Chrome (または Edge) で `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON にする
3. 「パッケージ化されていない拡張機能を読み込む」で `extension/` フォルダを選ぶ
4. 開いている x.com のタブを再読み込みする

Chrome 116 以降が必要。

## 使い方

- **保存**: ツイート下のアクションバーにある箱のアイコン（標準のブックマークボタンの位置）を押す。最後に使ったフォルダへすぐ保存され、ポップオーバーでフォルダやタグを変更できる。
- **編集・削除**: 保存済みのアイコン（塗りつぶし＋チェック）を押すと、ポップオーバーが開く。
- **一覧**: ツールバーの拡張機能アイコン、またはポップオーバーの「一覧を開く」から開く。
  - 検索（本文・ユーザー名・@ID・#タグ）、並び替え（保存日 / 投稿日）、グリッド / リスト表示
  - サイドバーでフォルダとタグを絞り込む（タグは複数選ぶと AND 条件）
  - カード右上の ⠿ をサイドバーのフォルダへドラッグすると移動
  - 画像をクリックするとライトボックス表示（← → で切り替え）
  - 保存時に取得できなかったメディアは、カードの「メディアを再取得」で取り直せる
- **設定・バックアップ**: 一覧ページ左下から開く。
  - 標準のブックマークボタンを隠すかどうか（既定: 隠す）
  - `.jsonl` 形式で書き出し / 読み込み（メディア込み、またはメタデータのみ）

## 保存される内容

| 内容 | 保存先 |
| --- | --- |
| 本文（t.co を展開済み）、投稿者、投稿日時、URL、フォルダ、タグ | `tweets` ストア |
| 画像（原寸）、動画（最高ビットレートの mp4）、GIF、動画のサムネイル | `media` ストア（Blob） |
| 引用ツイートの本文とメディア | `tweets.quote` と `media` ストア |
| アイコン画像 | `avatars` ストア（Blob） |

ツイート情報は次の順番で取得する。

1. X のページが受け取った GraphQL データ（`inject.js` が読み取る）。API の通信に加えて、HTML の `<script>` に埋め込まれた初期データも対象にする。動画の mp4 URL まで取れる
2. `cdn.syndication.twimg.com`（埋め込み用 API）
3. ページの DOM。この場合、動画はサムネイルしか保存できない

## 注意

- データは拡張機能の IndexedDB に入るので、**拡張機能をアンインストールすると消える**。定期的にバックアップを取ること。
- `unlimitedStorage` 権限があるので容量の上限は気にしなくてよいが、動画が多いとディスクを使う。
- X の DOM 構造や API が変わると、ボタンの位置やデータ取得が動かなくなることがある。2026 年 11 月時点の新しい DOM（`data-engagement-action`）と、従来の DOM（`data-testid`）の両方に対応している。

## 構成

```
extension/
  manifest.json
  viewer.html            一覧ページ
  icons/                 tools/make_icons.py で生成
  src/
    parse.js             GraphQL（旧 / 新スキーマ）/ syndication → 正規化ツイート
                         MAIN world は manifest で、ISOLATED world は動的 import で読み込む
    inject.js            MAIN world: fetch / XHR をフックしてツイートを抽出
    content.js/.css      ISOLATED world: ボタン挿入・ポップオーバー
    background.js        Service Worker: メディアのダウンロード・DB 書き込み
    db.js                IndexedDB アクセス層（background / viewer で共有）
    viewer.js/.css       一覧ページ
tests/                   node:test（parse / db）
```

## 開発

```sh
npm install   # fake-indexeddb（テスト用）
npm test
npm run icons # アイコン再生成
```
