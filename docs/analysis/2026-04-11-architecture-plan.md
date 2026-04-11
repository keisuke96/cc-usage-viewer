# アーキテクチャ案と移行順序

更新日: 2026-04-11

## 方針

今回の置き換えは、最初から大きい構成にしない。

重視すること:

- 現行互換を守る
- 小さい構成で始める
- 依存を増やしすぎない
- 後から機能追加しやすい

したがって、初期構成は `server / web / shared` の 3 分割に留める。

## 推奨ディレクトリ構成

```text
cc-usage-viewer/
  apps/
    server/
      src/
        routes/
        services/
        domain/
        lib/
        index.ts
      package.json
      tsconfig.json
    web/
      src/
        app/
        components/
        features/
        lib/
        main.tsx
      index.html
      package.json
      tsconfig.json
      vite.config.ts
  packages/
    shared/
      src/
        schemas/
        types/
        constants/
      package.json
      tsconfig.json
  docs/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  biome.json
```

## 各層の責務

### `apps/server`

ローカルファイルを読むバックエンド。

責務:

- `~/.claude/projects` の探索
- `sessions-index.json` 読込
- JSONL 読込
- チャット解析
- usage 集計
- tool 集計
- team session 紐付け
- HTTP API 提供
- ビルド済み web 配信

置かないもの:

- 画面ロジック
- UI 用の整形関数

### `apps/web`

UI 全体。

責務:

- プロジェクト一覧
- セッション一覧
- チャット表示
- 分析画面
- UI 状態管理
- グラフ描画

置かないもの:

- ファイルシステムアクセス
- JSONL パース本体

### `packages/shared`

共有型と schema。

責務:

- API request / response 型
- 共通定数
- 表示に依存しない構造型

注意:

- ここにロジックを集めすぎない
- 純粋に「共有が必要なもの」だけ置く

## server 内の初期構成

```text
apps/server/src/
  routes/
    projects.ts
    sessions.ts
    chat.ts
    analysis.ts
  services/
    get-projects.ts
    get-sessions.ts
    parse-chat.ts
    analyze-sessions.ts
    extract-tool-stats.ts
    extract-usage-timeline.ts
  domain/
    session.ts
    analysis.ts
    tool-stats.ts
  lib/
    fs.ts
    jsonl.ts
    safe-path.ts
    pricing.ts
  index.ts
```

### この粒度にする理由

- 現行 `token_viewer.py` の主要責務に対応している
- 1 ファイル 1 責務に近づけられる
- まだ深すぎない

## web 内の初期構成

```text
apps/web/src/
  app/
    App.tsx
    router.tsx
  components/
    layout/
    common/
  features/
    projects/
    sessions/
    chat/
    analysis/
  lib/
    api.ts
    query-client.ts
    format.ts
  main.tsx
```

### feature 単位

#### `features/projects`

- project list
- project selection

#### `features/sessions`

- session list
- subagent / team session row

#### `features/chat`

- message list
- markdown rendering
- tool use/result block

#### `features/analysis`

- summary card
- model rows
- usage timeline chart
- tool stats chart

## 画面構成

初期リプレースでは、現行に合わせて次だけ作る。

### 1. メイン画面

- 左: project list
- 中: session list
- 右: content area

### 2. タブ

- `チャット`
- `分析`

### 3. 作らない画面

- agent graph 画面
- 比較専用画面
- 設定画面

## API 方針

REST で十分。

想定 API:

- `GET /api/projects`
- `GET /api/sessions?project=<id>`
- `GET /api/chat?file=<path>`
- `POST /api/analyze`
- `GET /api/mtime?file=<path>`
- `GET /api/project-mtime?project=<id>`

補足:

- `GET /api/agent-graph` は初期リプレースでは不要
- ただし server 内部の agent graph 抽出ロジックは team session 紐付けに残す

## 移行順序

互換リプレースでは、表示からではなく「下から」移す。

### Phase 1. ワークスペースと土台作成

やること:

- `pnpm workspace` 作成
- `apps/server` 作成
- `apps/web` 作成
- `packages/shared` 作成
- `Biome` 導入
- TypeScript 設定作成

完了条件:

- server と web が空でも起動する

### Phase 2. server の純粋ロジック移植

やること:

- pricing
- JSONL 読込
- project discovery
- session discovery
- chat parser
- usage analytics
- tool stats
- usage timeline
- team session 紐付け

この phase では UI を作らない。

完了条件:

- 現行代表ログに対して、主要ロジックの出力が一致する

### Phase 3. server API 化

やること:

- REST route 実装
- Zod schema 定義
- API response を固定

完了条件:

- 現行相当の API が返せる

### Phase 4. 最小 UI 作成

やること:

- 3 カラムレイアウト
- project list
- session list
- chat tab
- analysis tab

完了条件:

- 現行 viewer と同じ導線で基本操作できる

### Phase 5. 分析 UI 強化

やること:

- usage timeline を ECharts 化
- tool stats を ECharts 化
- summary / model card を整理

完了条件:

- 現行分析画面以上に見やすい
- ただし機能互換は維持

### Phase 6. 仕上げ

やること:

- 不要 API の見直し
- dead code 削除
- 文書更新

完了条件:

- 現行互換の置き換えとして運用可能

## テスト方針

E2E は入れない。

代わりに以下を重視する。

### server

- fixture ベースの単体テスト
- parser テスト
- analytics テスト
- team session 紐付けテスト

### web

- formatter / renderer の軽いテスト
- 必要なら重要コンポーネントのスモークテスト

## 現時点で作らないもの

- React Flow
- Playwright
- tRPC
- Zustand
- 複雑な認証
- DB
- Electron 化

## この構成の利点

- 小さい
- 役割分担が明確
- 依存が少ない
- 現行仕様を段階的に移しやすい
- 将来 ECharts を中心に分析だけ強化しやすい

## 次の実作業

次に着手するべきなのは以下。

1. `pnpm workspace` の雛形作成
2. server / web / shared の最小 scaffold 作成
3. 現行 Python のロジックを移植する単位で issue 化またはチェックリスト化
