# 現行実装分析

更新日: 2026-04-11

## 目的

`cc-usage-viewer` は、Claude Code のセッションログをローカルで閲覧・分析するためのビューアです。`~/.claude/projects/` 配下の JSONL を直接読み込み、チャット再生と使用量分析を行います。

## 現行技術構成

- 実装言語: Python 3
- 依存関係: 標準ライブラリのみ
- HTTP サーバー: `http.server`
- フロントエンド: Python 文字列に埋め込まれた HTML / CSS / Vanilla JavaScript
- エントリポイント: `python3 token_viewer.py [--port 8765] [--no-browser]`

## ファイル構成

現行のアプリ本体は実質 1 ファイルです。

- `token_viewer.py`
  - ログ探索
  - JSONL 解析
  - 使用量集計
  - ツール統計集計
  - エージェントグラフ抽出
  - HTTP API
  - HTML / CSS / JavaScript の配信
- `README.md`
  - 起動方法の簡易説明

## 現行機能一覧

### 1. プロジェクト一覧表示

- `~/.claude/projects/` 配下のディレクトリを列挙
- `sessions-index.json` があれば `originalPath` を使って表示名を補正
- セッション数を一覧表示
- セッションが空のプロジェクトは UI で非表示切り替え可能

### 2. セッション一覧表示

- 各 `*.jsonl` をトップレベルセッションとして列挙
- `sessions-index.json` があれば summary / firstPrompt / created / modified を優先
- なければ JSONL から最初のユーザーメッセージを抽出してラベル化
- サブエージェントを `subagents/*.jsonl` と `.meta.json` から列挙
- チームセッションを親セッションへ再紐付けし、トップレベル一覧から除外
- メッセージのないセッションは UI で非表示切り替え可能

### 3. チャット再生

- JSONL を `uuid` 単位で集約し、後勝ちで完全版を採用
- `user` / `assistant` メッセージを時系列で表示
- 対応コンテンツ:
  - `text`
  - `thinking`
  - `tool_use`
  - `tool_result`
- システム注入系プレフィックスは除外
- `<local-command-stdout>` は `tool_result` 扱いに変換
- Markdown ライクな描画、コードブロック、テーブル、差分表示に対応

### 4. セッション分析

- モデル別 usage 集計
- 合計 usage 集計
- 項目:
  - `input_tokens`
  - `output_tokens`
  - `cache_creation_5m`
  - `cache_creation_1h`
  - `cache_read_tokens`
  - `requests`
  - `latest_total_input_tokens`
  - `latest_output_tokens`
- Cache hit rate 算出
- モデル別コスト推定
- セッション単位の usage timeline 表示
- サブエージェント usage の個別表示
- セッション合算値の表示

### 5. プロジェクト一括分析

- 選択中プロジェクトの全セッションをまとめて分析
- フロント側で `mtime` ベースのキャッシュを保持
- プロジェクト全体の合計値、セッションカード、ツール統計を表示

### 6. ツール使用統計

- `tool_use` / `tool_result` を集計
- ツール種別ごとの回数表示
- `Bash` は実行コマンド名ごとに内訳集計
- `Skill` は skill 名ごとに内訳集計
- `Agent` はサブエージェント種別ごとに内訳集計
- ツールエラー件数を表示

### 7. エージェントグラフ抽出

- `Agent`
- `TeamCreate`
- `SendMessage`
- `queue-operation`

上記のログから、以下を抽出するロジックを持ちます。

- エージェント一覧
- チーム構造
- メッセージフロー
- 完了状態
- サブエージェント JSONL への対応付け

補足:

- バックエンド API とフロント側描画関数は存在する
- ただし現行 UI には明示的な導線がなく、未接続機能に見える

## HTTP API 一覧

- `GET /`
- `GET /api/projects`
- `GET /api/sessions?project=<id>`
- `GET /api/chat?file=<path>`
- `GET /api/agent_graph?file=<path>`
- `GET /api/mtime?file=<path>`
- `GET /api/project_mtime?project=<id>`
- `POST /api/analyze`

## 重要な現行仕様

リプレース時に落とすと互換性が崩れるため、以下は維持対象です。

### ログ探索仕様

- データソースは `~/.claude/projects/`
- `sessions-index.json` が存在する場合は優先利用
- サブエージェントは `<session>/subagents/*.jsonl`
- メタ情報は `*.meta.json`

### 表示ラベル仕様

- 最初のユーザーメッセージを抽出してセッションタイトルにする
- システム注入メッセージは除外
- `/commit` のような単独スラッシュコマンドは除外
- `/Users/...` のようなパスは除外しない

### Token Usage 仕様

- 単純累計ではなく、`最新リクエスト 1 件の総入力 + 総出力` を Token Usage として使う箇所がある
- `Total Output` と Cache 系は累計値

### コスト計算仕様

- 料金表はコード内定義
- モデル名の prefix 部分一致で料金表を決定
- 未知モデルが含まれると total cost は `None` になり得る

### チームセッション仕様

- `<teammate-message>` をチームセッション判定に利用
- `TeamCreate` がある親セッションから対応する team session を紐付ける

## 構造上の問題

### 1. 単一ファイル集中

`token_viewer.py` に以下の責務が集中しています。

- ドメインロジック
- ログ読込
- 集計ロジック
- API
- 画面テンプレート
- スタイル
- フロントエンド状態管理
- UI 描画

変更時の影響範囲が広く、保守性が低い状態です。

### 2. 境界不在

バックエンドとフロントエンドの責務境界がなく、UI 変更と分析ロジック変更が同一ファイルで衝突します。

### 3. 型とデータモデルの不足

ログレコード、セッション、分析結果、ツール統計などが生の `dict` 中心で扱われています。拡張時の破壊的変更検知が難しい構造です。

### 4. 現行仕様がコードに埋没

`<teammate-message>` 連携、スキップ対象プレフィックス、Token Usage の定義など、重要仕様がコード中の条件分岐に散在しています。

### 5. テスト基盤不在

リポジトリ内にテスト、lint、format の仕組みがありません。リプレース前に仕様を固定するには、まずこの文書のような仕様化が必要です。

## リプレース時の責務分割案

最低でも以下の単位には分けるべきです。

- project discovery
- session discovery
- chat parser
- usage analytics
- tool analytics
- agent graph
- API layer
- frontend

## 優先度の高い移行前タスク

1. 現行仕様の文書化
2. 互換対象機能の固定
3. 主要ロジックのフィクスチャ化
4. 置き換え先の技術選定
5. 画面と API の分割設計

## 参照ポイント

- 集計: `token_viewer.py` の `load_jsonl_for_analysis`, `aggregate`, `analyze_structured`
- ツール統計: `extract_tool_stats`
- エージェント構造: `extract_agent_graph`
- チャット解析: `parse_chat`
- タイムライン: `extract_usage_timeline`
- プロジェクト/セッション探索: `get_projects`, `get_sessions`
- API: `Handler`
- UI: `HTML` 定数内 JavaScript
