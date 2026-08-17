# rb2spot

[English](./README.md) | **日本語**

> rekordbox のプレイリストを Spotify に Sync する CLI ツール

**[ChiakiUehira/rekordbox2spotify](https://github.com/ChiakiUehira/rekordbox2spotify)**（MIT）のフォークです。
オリジナルのマッチング方式と「rekordbox がマスター」という設計はそのままに、以下を変更しています。

- **現行の Spotify API エンドポイントに対応** — プレイリストの作成、内容の読み書きを、
  Spotify が実際に提供しているパスで行います。旧パスは素の `403` を返し、旧フィールド
  指定は `200` で空オブジェクトを返すため、全プレイリストが空と誤認され無駄に上書き
  されていました
- **あらゆる環境でパスを解決** — Windows のドライブレター、WSL のマウント先、macOS の
  外付けドライブに対応（従来は macOS のホーム配下のみ）。それ以外の場所にライブラリが
  あるとタグが一切読めず、ISRC マッチングが常に使えない状態でした
- **マッチングの刷新** — タイトル・バージョン識別子・アーティストを個別に採点し、
  アーティストは集合として比較、リミックスと原曲を区別、再生時間によるタイブレークも
  実際に動作します。2000 曲規模の実測で **1492 → 1803 件マッチ**
- **同じ問い合わせを繰り返さない** — タグはサイズと更新時刻、検索結果はリクエスト URL を
  キーにキャッシュ。中断時も保存されるため、次回実行は続きから再開でき、API クォータを
  二重に消費しません
- **読める進捗表示** — フェーズごとの進捗バー、件数、残り時間の目安、停滞インジケータ。
  パイプ時は通常の行出力に切り替わります
- **レート制限を明示的に処理** — リクエストを一定間隔に保ち、制限時は自動的に間隔を拡大。
  `Retry-After` は両形式に対応し、数時間規模のペナルティ期間では待ち続けずに再実行可能な
  時刻を示して中止します
- **設定可能** — プレフィックス、フォルダ区切り、公開範囲、キャッシュ有効期限、ログ出力先を
  設定から反映（従来はハードコード）。`--no-unfollow` により、一部だけ同期しても対象外の
  プレイリストが削除扱いになりません
- **dry-run で差分を表示** — 件数ではなく、各プレイリストで増減するトラックを表示します
- **プレイリストの選択** — 名前・フォルダ・グロブによる include/exclude
- **CI、型チェックのクリーン化、所有者のみ読めるトークンファイル**

rekordbox で管理しているプレイリストを、Spotify 上に同じ構成で作成・同期します。rekordbox 側で曲を追加・削除・並び替えるたびに、次回の sync で Spotify にも反映されます。普段は rekordbox で選曲・整理して、移動中はスマホで Spotify、というワークフローが組めます。

## 特徴

- **多段マッチング戦略** — URI 直取り → ID3 タグの ISRC → 正規化 Artist+Title → Levenshtein ファジー
- **ID3 直読み** — rekordbox 自身は ISRC を持っていないので、ローカル音声ファイル（MP3/AIFF）から直接 ISRC を読み出してマッチ精度を高める
- **rekordbox がマスター** — rekordbox 側の状態を Spotify に完全反映。曲を外せば Spotify からも消える
- **冪等同期** — 何度実行しても結果が収束する。途中で止まっても再実行すれば続きから処理
- **フォルダ階層対応** — rekordbox の `Genre/Techno` などのフォルダ階層を `[RB] Genre/Techno` のように命名で表現
- **dry-run モード** — 書き込み前にプランを確認できる
- **未マッチ CSV 出力** — Spotify に存在しなかった曲を CSV で記録

## クイックスタート

### 必要環境

- macOS / Windows / WSL。XML 内のトラックパスは実行環境に応じて解決されます
  （外付けドライブや、別 OS で書き出したライブラリにも対応）
- [Bun](https://bun.sh) >= 1.1
- rekordbox 6 以降
- Spotify アカウント（無料/有料どちらでも可）

### 1. インストール

#### npm 経由（推奨）

```bash
bun install -g rb2spot
mkdir ~/Music/rekordbox-sync && cd ~/Music/rekordbox-sync
rb2spot init-workspace
```

#### ソースから

```bash
git clone https://github.com/tomnz/rb2spot.git
cd rb2spot
bun install
```

### 2. rekordbox から XML をエクスポート

rekordbox を開いて「ファイル → ライブラリ → コレクションを XML 形式で書き出し」を実行。デフォルトの出力先は `~/Documents/rekordbox.xml` です。

設定で「自動エクスポート」を有効にすると、毎回手動操作する必要がなくなります（環境設定 → 詳細 → データベース）。

### 3. Spotify Developer App を作成

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) にログイン
2. **「Create app」** をクリック
3. フォーム入力：
   - **App name**: 任意（例: `rb2spot`）
   - **App description**: 任意
   - **Redirect URI**: `http://127.0.0.1:8888/callback`（コピペ推奨）
   - **APIs used**: **Web API** にチェック
4. 利用規約に同意して **Save**
5. 作成された App → **Settings** から **Client ID** と **Client Secret** を取得

### 4. `.env` を作成

```bash
cp .env.example .env
```

`.env` を編集して Client ID / Secret を貼り付け：

```
SPOTIFY_CLIENT_ID=ここに貼る
SPOTIFY_CLIENT_SECRET=ここに貼る
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

### 5. Spotify 認証

```bash
bun run rb2spot init
```

ブラウザが Spotify 認証ページに飛ぶので、ログインして同意。完了するとトークンが `.cache/spotify_token.json` に保存されます。

### 6. 同期

まず dry-run で計画を確認：

```bash
bun run rb2spot sync --xml ~/Documents/rekordbox.xml --dry-run
```

問題なさそうなら本番実行：

```bash
bun run rb2spot sync --xml ~/Documents/rekordbox.xml
```

Spotify に `[RB] {playlist_name}` 形式のプレイリストが作成されます。

---

## コマンドリファレンス

### `init` — Spotify OAuth 認証

```bash
bun run rb2spot init
```

初回のみ必要。`.cache/spotify_token.json` にリフレッシュトークンが保存されるので、以降は自動でリフレッシュされます。

### `sync` — 同期実行

```bash
bun run rb2spot sync --xml <path> [--dry-run] [--out-dir <dir>]
```

| オプション | 説明 |
|---|---|
| `--xml <path>` | rekordbox XML のパス（省略時は `config.yaml` → 既定パス順） |
| `--dry-run` | 書き込みなしで計画だけ表示 |
| `--out-dir <dir>` | ログ出力先（既定: `./logs`） |
| `--include <pattern>` | マッチしたプレイリストのみ同期。複数指定可。`include_playlists` を上書き |
| `--exclude <pattern>` | マッチしたプレイリストを除外。複数指定可。`ignore_playlists` を上書き |
| `--quiet` | 途中経過を抑制し、最終サマリのみ表示 |
| `--rate <n>` | Spotify への毎秒リクエスト数（既定 1）。extended quota がある場合は上げる |
| `--no-cache` | 2 つのキャッシュを無視して全件読み直す |
| `--full` | dry-run で全トラックの差分を表示（既定は先頭のみ） |
| `--no-unfollow` | 今回選択されなかったプレイリストをそのまま残す |
| `--unfollow` | `spotify.unfollow_removed` を上書きしてフォロー解除を有効化 |

`output.cache_dir`（既定 `./.cache`）に 2 つのキャッシュを保存します。どちらも
`--no-cache` で無効化できます。

**ID3 タグ**: キーはファイルのサイズと更新時刻。タグを編集・差し替えたファイルは自動的に
読み直され、変更のないファイルは開いて解析する代わりに `stat` 1 回で済みます。ライブラリが
ネットワークドライブ上にある場合に特に有効です（実測例: 92ms/ファイル → 6ms/ファイル）。

**Spotify 検索結果**: キーはリクエスト URL。2 回目以降の同期では未検索のトラックのみを
問い合わせます。ヒットした結果は**無期限**にキャッシュされます（Spotify URI は恒久的な
識別子であり、保存しているのはマッチ結果ではなく候補リストなので、スコアリングは毎回
ローカルで再実行され、閾値の変更も反映されます）。該当なしの結果は 30 日で失効するため、
先月なかった曲も再確認されます。中断時やレート制限による停止時にも保存されるため、次回
実行は続きから再開でき、同じクォータを二重に消費しません。

レート制限に繰り返し掛かる場合、効くのは後者です。クォータはリクエスト単位で消費されるため、
キャッシュから返る検索はクォータを消費しません。

同期中は、タグ読み込み・Spotify とのマッチング・プレイリスト更新の各フェーズを、
進捗バーと残り時間の目安付きで表示します。出力をパイプやファイルにリダイレクトした
場合は、ログが読みやすいよう通常の行出力に切り替わります。

### `list-playlists` — 同期対象の確認

```bash
bun run rb2spot list-playlists --xml <path> [--include <pattern>] [--selected-only]
```

プレイリストをフォルダパス付きで一覧表示します。このパスがパターンのマッチ対象です。フィルタ適用時は、同期対象に `+`、除外に `-` が付きます。

> **注意:** 対象を絞ると、選択から外れた `[RB] ` プレイリストは削除扱いとなり、次回同期でフォロー解除されます。フィルタ変更時はまず `--dry-run` で確認してください。

### `verify` — XML 診断

```bash
bun run rb2spot verify --xml <path> [--include <pattern>] [--exclude <pattern>]
```

rekordbox XML から取れるメタデータを診断してレポート出力。ISRC カバレッジ、インテリジェントプレイリスト疑い、フォルダ階層などを確認できます。

### `unmatched` — 未マッチ曲の確認

```bash
bun run rb2spot unmatched
```

直近の sync で Spotify にマッチできなかった曲一覧を表示します。CSV ファイルは `./logs/unmatched_*.csv` に保存。

---

## 設定 (`config.yaml`)

任意です。すべての設定に既定値があるため、設定ファイルなしでも動作します。
`config.example.yaml` は**すべての項目がコメントアウトされ、既定値が併記された**
状態で同梱されているので、コピーしただけでは挙動は変わりません。

```bash
cp config.example.yaml config.yaml
```

| 設定 | 既定値 | 補足 |
|---|---|---|
| `rekordbox.xml_path` | `~/Documents/rekordbox.xml` | 多くの人が設定する唯一の項目 |
| `rekordbox.include_playlists` | *(すべて)* | 指定時はこれだけ同期。グロブ可 |
| `rekordbox.ignore_playlists` | *(なし)* | 除外。`include_playlists` の後に適用 |
| `spotify.playlist_prefix` | `"[RB] "` | 自分の管理下を判別する識別子でもある（下の注意参照） |
| `spotify.folder_separator` | `/` | フォルダ階層を名前に連結する文字 |
| `spotify.visibility` | `private` | 本ツールが作成するプレイリストに適用 |
| `spotify.requests_per_second` | `1` | 制限時は下げる。extended quota があれば上げる |
| `matching.fuzzy_threshold` | `0.85` | 低いほど寛容、誤マッチリスク増 |
| `matching.duration_tolerance_ms` | `3000` | 同点候補を再生時間で絞る幅 |
| `matching.prefer_original_mix` | `true` | 同点時に "Original Mix" を優先 |
| `output.log_dir` | `./logs` | サマリと未マッチ CSV の出力先 |
| `output.cache_dir` | `./.cache` | トークンと 2 つのキャッシュ |
| `output.search_cache_hit_days` | `never` | ヒットは無期限。日数指定で再確認 |
| `output.search_cache_miss_days` | `30` | 該当なしの再確認間隔（クォータを消費） |

> **`playlist_prefix` の変更は慎重に:** 名前の生成と、管理対象の判別の両方に使われます。
> 変更すると既存の同期済みプレイリストが認識されなくなり、削除扱いで次回同期時に
> フォロー解除されます。変更時はまず `--dry-run` で確認してください。
---

## 同期の挙動

| 操作 | 次回 sync 後の Spotify 側 |
|---|---|
| rekordbox で曲追加 | プレイリストに追加 |
| rekordbox で曲削除 | プレイリストから削除 |
| rekordbox で曲の順序入れ替え | 順序も反映 |
| rekordbox でプレイリスト削除 | Spotify 側も unfollow（プレイリスト自体は残るが自分のライブラリから外れる） |
| rekordbox でプレイリスト名変更 | 古い名前のは unfollow、新しい名前で再作成 |
| Spotify 側で手動編集 | **次回 sync で上書きされる**（rekordbox がマスター） |

各プレイリストの description には `Last synced: YYYY-MM-DD HH:MM JST` が記録されるので、最終同期時刻を確認できます。

---

## マッチング戦略

各曲ごとに以下の順で試行し、ヒットしたら次の曲へ：

| 順 | 戦略 | 内容 | 信頼度 |
|---:|---|---|---:|
| 1 | **URI 直取り** | rekordbox の Location が `spotify:track:XXX`（Spotify連携曲） | 1.00 |
| 2 | **ISRC マッチ** | ローカル音声ファイルの ID3 タグから ISRC を取得 → Spotify isrc検索 | 0.95 |
| 3 | **正規化 Exact** | タイトル/アーティストを正規化（`(Original Mix)` `feat.` `(GB)` 等を除去）して完全一致 | 0.85 |
| 4 | **Fuzzy** | タイトル・バージョン識別子・アーティストを個別に採点し、閾値以上の最高スコア候補 | 0.85〜1.00 |
| 5 | **Duration tiebreaker** | 候補が同点なら再生時間 ±3秒 で絞り込み + `prefer_original_mix` 適用 | — |

すべて失敗した曲は `logs/unmatched_*.csv` に記録されます。

### 正規化ルール

タイトル末尾サフィックス、`feat.`/`ft.`/`featuring` 句、アーティスト末尾の国コード `(GB)` `(IT)` 等を除去：

| 入力 | 正規化後 |
|---|---|
| `Echoes (Original Mix)` | `echoes` |
| `Echoes - Original Mix` | `echoes` |
| `Copper Lake - Aurora Pike Remix` | `copper lake` + リミックス識別子 |
| `Paper Tigers (with Vela Sound)` | `paper tigers` |
| `Track feat. Someone (Extended Mix)` | `track` |
| `FLETCH (GB)` | `fletch` |
| `Ｅｃｈｏｅｓ` | `echoes` |

---

## 既知の制約

### Spotify Web API の制約

- **フォルダ操作 API がない**：Spotify はプレイリストフォルダを Web API で操作する手段を提供していません。階層は `[RB] Genre/Techno` のように命名で表現するのみ。フォルダ整理は Spotify アプリで手動で行ってください
- **真に秘密なプレイリストは作れない**：`public: false` で作成しても、URL を知っていれば誰でもアクセス可能（Spotify の仕様）

### rekordbox の制約

- **rekordbox は ISRC をサポートしていない**：rekordbox の UI にも XML にも ISRC が出力されません。本ツールはローカルファイルの ID3 タグから直接読み取って補完します
- **`master.db` は SQLCipher で暗号化**：rekordbox 6 以降の DB は本ツールでは読めません。XML エクスポートが必須です

### Spotify に存在しない曲

Bandcamp 限定リリース / 自Dub / レーベル限定エディット / 古いブートレグなどは Spotify に存在しないため unmatched 行きになります。`logs/unmatched_*.csv` で確認できます。

---

## トラブルシューティング

### `Spotify トークン未取得です` エラー

```bash
bun run rb2spot init
```

を実行してください。初回認証またはトークン再取得が必要です。

### マッチ率が低い

1. `config.yaml` の `matching.fuzzy_threshold` を下げる（既定 0.85 → 0.75）。ただし誤マッチリスクが上がります
2. `unmatched` で内訳を確認：Bandcamp 系が大半なら諦め、表記揺れなら閾値調整で救える可能性

### `[RB]` プレイリストが Public 表示になる

Spotify アプリで「Settings → Social → Automatic new playlists are public」を **OFF** にしてください。API で `public: false` を送っても、この設定がオンだと上書きされる場合があります。

### 「rate limited by Spotify」と表示される

Spotify はアプリ単位・ローリングウィンドウでレート制限をかけており、上限値は公開
されていません。本ツールは既定で毎秒 1 リクエストに抑え、制限を受けた場合は自動的
に間隔を広げます。

1 分以内の短い制限は待機して再試行します。`Retry-After` がそれより長い場合は、単に
上限を超えたのではなく**ペナルティ期間**に入っています。この期間中の再試行は期間を
延長させる可能性があるため、同期を即座に中止し、再実行可能な時刻を表示します。数時間
に及ぶ場合は、アプリの割り当てを使い切っている可能性が高いです。

**レート超過か、クォータ切れか**: 対処法が異なりますが、症状で判別できます。実行開始から
数秒で制限がかかる場合はレート超過なので、`--rate` または `spotify.requests_per_second` を
下げてください。数分間は正常に進み、毎回**ほぼ同じリクエスト数**で停止する場合はクォータ
切れです。この場合レートを下げても同じ上限に遅く到達するだけなので、リクエスト総数を
減らすか、開発者ダッシュボードで **extended quota mode** を申請してください（既定の
*development mode* は割り当てが小さくなります）。

**クォータより大きいライブラリを同期するには**: マッチングはプレイリスト書き込みより前に
実行されるため、マッチング中に停止した実行は Spotify を更新するところまで到達しません。
対処は 2 通りあります。

- *キャッシュを育てる*: 完了した検索は無期限にキャッシュされるため、実行のたびに前回より
  先へ進みます。数回繰り返せばクォータを消費せずにマッチングが完了し、同期まで到達します。
- *少しずつ同期する*: `--include` でマッチング対象を絞れば、1 回の実行が最後まで完了し、
  実際にプレイリストが書き込まれます。

  ```bash
  bun run rb2spot sync --xml <path> --include "House/**"
  ```

  ただし対象を絞ると、選択から外れた既存の `[RB] ` プレイリストはフォロー解除されます。
  詳細は上記の注意書きを参照してください。

### dry-run で何も起こらない

これは正常です。`--dry-run` を外して本番実行してください。

```bash
bun run rb2spot sync --xml ~/Documents/rekordbox.xml
```

---

## 開発者向け

### ローカル開発

```bash
bun install
bun test            # 全テスト実行
bun run typecheck   # 型チェック
```

### アーキテクチャ

```
src/
├── cli.ts                  # commander エントリ
├── verify.ts               # XML 診断
├── sync.ts                 # 同期オーケストレーション
├── readers/
│   ├── xml.ts              # rekordbox XML パーサ
│   ├── db-probe.ts         # master.db 診断
│   └── id3.ts              # ID3 タグ → ISRC 抽出
├── spotify/
│   ├── auth.ts             # OAuth + トークン管理
│   ├── client.ts           # API クライアント (rate limit + retry)
│   └── playlist.ts         # プレイリスト CRUD
├── matcher/
│   ├── normalize.ts        # 文字列正規化
│   ├── strategies.ts       # 各マッチング戦略
│   └── index.ts            # 多段オーケストレーション
├── unmatched.ts            # CSV 入出力
├── report.ts               # verify レポート出力
└── types.ts                # 共通型定義
```

### 設計ドキュメント

- M0 設計: [`docs/superpowers/specs/2026-05-21-rb-spot-m0-design.md`](docs/superpowers/specs/2026-05-21-rb-spot-m0-design.md)
- M1 設計: [`docs/superpowers/specs/2026-05-21-rb-spot-m1-design.md`](docs/superpowers/specs/2026-05-21-rb-spot-m1-design.md)

### コントリビューション

Issue / PR 歓迎。バグ報告や機能リクエストは [GitHub Issues](https://github.com/tomnz/rb2spot/issues) へ。

---

## ライセンス

[MIT License](LICENSE)
