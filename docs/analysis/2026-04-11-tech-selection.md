# 技術選定

更新日: 2026-04-11

## 前提の更新

今回の技術選定は、以下の前提で見直した。

- デッドコード以外は互換でリプレースする
- 言語は固定しない
- UI は既成ライブラリで実装量を下げたい
- グラフは今後もっとリッチにしたい
- 利用者は個人またはごく小さい社内チーム
- 運用規模より、保守コストの低さを重視する
- E2E テストは不要

## agent graph の扱い

### 結論

- `extract_agent_graph` 自体はデッドコードではない
- ただし、現行の「agent graph 画面」はデッドコード扱いでよい

### 根拠

#### 生きている部分

`extract_agent_graph()` は、セッション一覧構築時に team session の紐付けへ使われている。

- [token_viewer.py](/Users/keisuke/cc-usage-viewer/token_viewer.py:1051) で `extract_agent_graph()` を呼んでいる
- [token_viewer.py](/Users/keisuke/cc-usage-viewer/token_viewer.py:1062) 以降で `team_sessions` を構築している

このため、バックエンド側の agent graph 抽出ロジックは現行機能の一部であり、互換対象に含めるべき。

#### 死んでいる部分

agent graph の UI は現行画面から到達できない。

- 右ペインのタブは `チャット` と `分析` の 2 つだけで、graph タブがない
  - [token_viewer.py](/Users/keisuke/cc-usage-viewer/token_viewer.py:1543)
- `loadAgentGraph()` と `renderAgentGraph()` は定義されている
  - [token_viewer.py](/Users/keisuke/cc-usage-viewer/token_viewer.py:3006)
  - [token_viewer.py](/Users/keisuke/cc-usage-viewer/token_viewer.py:3017)
- しかし `graph-body` を持つ画面要素が現行 HTML に存在しない
  - 右ペインは [token_viewer.py](/Users/keisuke/cc-usage-viewer/token_viewer.py:1541) から [token_viewer.py](/Users/keisuke/cc-usage-viewer/token_viewer.py:1562) までで完結している
- `/api/agent_graph` はあるが UI からは呼ばれない
  - [token_viewer.py](/Users/keisuke/cc-usage-viewer/token_viewer.py:3213)

したがって、React Flow を入れて graph 画面を再現する必要は現時点ではない。

## 結論

現時点の第一推奨スタックは以下。

- ランタイム: `Node.js 22 LTS`
- バックエンド: `Fastify` + `Zod`
- フロントエンド: `React` + `TypeScript` + `Vite`
- UI コンポーネント: `Material UI`
- データ取得: `TanStack Query`
- グラフ: `Apache ECharts`
- テスト: `Vitest`
- 開発基盤: `pnpm` + `Biome`

### 明示的に外すもの

- `React Flow`
- `Playwright`
- `tRPC`
- `Zustand`

## なぜこの構成にするか

### 1. 小規模運用に対して過不足が少ない

この viewer は SaaS ではなく、個人またはごく小さいチーム内で使うローカル分析ツールである。したがって、将来の大規模分散運用や複雑な認証基盤を前提にした設計は不要。

必要なのは次の 3 点。

- 現行仕様を安全に分割実装できること
- UI 実装量を削減できること
- 将来の分析画面拡張に耐えること

前回案の `tRPC`, `React Flow`, `Playwright`, `Zustand` は、現時点のスコープに対してはやや過剰。

### 2. TypeScript 統一の利点はまだ大きい

言語に制約がないなら、今回は Python 継続より TypeScript 統一の方が有利。

理由:

- フロントとバックで型定義を共有しやすい
- UI が主役のプロジェクトなので React 資産を最大限使える
- JSONL の読込と集計は Node でも十分実装可能
- 将来のグラフ拡張がしやすい

### 3. ただし「型共有のための追加フレームワーク」は載せすぎない

`tRPC` は便利だが、このアプリの API は少数で読み取り中心。

現状の主要 API はこれだけ。

- projects
- sessions
- chat
- analyze
- mtime
- project_mtime

この規模なら、`Zod` で request / response を定義し、薄い REST API を作るだけで十分に管理できる。`tRPC` を入れるより、以下の方が保守しやすい。

- サーバーは plain REST
- 型は `shared` に置く
- クライアントは薄い `api.ts` で包む

## 採用技術

### ランタイム: Node.js 22 LTS

採用理由:

- 安定した LTS が使える
- フロントと同じ TypeScript エコシステムで統一できる
- ローカルファイル読込と SPA 配信に向く

### バックエンド: Fastify

採用理由:

- 十分成熟している
- plugin 指向で責務分割しやすい
- 速く、ローカルツールにも素直
- Express より型と構成が扱いやすい

役割:

- `~/.claude/projects` の走査
- JSONL 読込
- チャット解析
- 集計
- team session 紐付け
- API 提供
- ビルド済みフロント配信

### バリデーション/型: Zod

採用理由:

- TypeScript-first
- request / response / 内部モデルの境界を明確にできる
- 過剰な枠組みを足さずに型安全を上げられる

役割:

- API schema
- ログ正規化
- 集計結果 schema

### フロントエンド: React + TypeScript + Vite

採用理由:

- ライブラリ資産が厚い
- コンポーネント分割しやすい
- Vite で開発とビルドが軽い
- SSR は不要なので Next.js は不要

### UI: Material UI

採用理由:

- よく使われている
- レイアウト、タブ、リスト、ダイアログ、テーブルなどが揃っている
- ダッシュボード系 UI を早く組める

役割:

- 全体レイアウト
- プロジェクト/セッション一覧
- タブ
- 各種カード
- フィルタ UI

### データ取得: TanStack Query

採用理由:

- async state の面倒を減らせる
- キャッシュ、再取得、ローディング、エラー管理が素直
- 現行の `mtime` ベース再取得とも相性がよい

役割:

- projects query
- sessions query
- chat query
- analysis query

### グラフ: Apache ECharts

採用理由:

- 今後の分析画面拡張に十分強い
- 棒/折れ線だけでなく、heatmap, treemap, graph, custom まで射程に入る
- 「分析用途」に最も向いている

役割:

- usage timeline
- モデル別比較
- cache hit 可視化
- セッション比較
- 将来の分布/相関/密度可視化

補足:

- agent graph UI を将来復活させる場合も、まずは ECharts の `graph` / `tree` 系で十分かを先に検討する
- 現時点では React Flow は不要

### テスト: Vitest

採用理由:

- 小規模プロジェクトで十分
- フロントのコンポーネントとサーバーの純粋関数を同じ流儀で検証できる
- 設定が軽い

対象:

- parser テスト
- 集計テスト
- team session 紐付けテスト
- API 単体テスト
- 軽い component test

### 開発基盤: pnpm + Biome

採用理由:

- `pnpm` は workspace を軽く運用できる
- `Biome` は formatter + linter を 1 つに寄せられる
- `ESLint + Prettier` より設定保守が軽い

## 採用しない技術

### React Flow

今回は不採用。

理由:

- 現行の graph UI は死んでいる
- graph 可視化が今すぐ必須ではない
- 依存を 1 つ増やす割に、当面の価値が薄い

ライセンス補足:

- React Flow 本体は MIT ライセンス
- ただし Pro examples や周辺商用サービスがあるため、有償ライブラリの印象を持ちやすい
- 今回はそもそも不要なので採用しない

### Playwright

今回は不採用。

理由:

- E2E テストは不要という前提
- 個人/小規模チーム用ツールとしては回帰コストが重い
- まずは parser / analytics / API の単体テスト優先で十分

### tRPC

今回は不採用。

理由:

- API 数が少ない
- 読み取り中心
- Zod 共有 + 薄い fetch wrapper で十分
- 導入メリットより学習/保守コストの方が目立つ

### Zustand

初期構成では不採用。

理由:

- この規模なら React state と TanStack Query で足りる可能性が高い
- 早期導入すると state の置き場が二重化しやすい

## 推奨構成

```text
cc-usage-viewer/
  apps/
    server/
      src/
        domain/
        parsers/
        analytics/
        routes/
        lib/
        index.ts
    web/
      src/
        components/
        features/
        pages/
        lib/
        main.tsx
      vite.config.ts
  packages/
    shared/
      src/
        schemas/
        types/
  docs/
```

## 実装方針

### サーバー

- 先に現行の Python ロジックを責務で分割して TypeScript に移す
- 特に以下を独立モジュールにする
  - project discovery
  - session discovery
  - chat parser
  - usage analytics
  - tool analytics
  - team session linkage

### フロント

- まずは現行と同じ 2 ペイン + 2 タブ構成を作る
- graph 画面は作らない
- 先に「一覧」「チャット」「分析」の 3 機能を互換で固める

### テスト

- 最優先は parser と analytics
- UI は重要な formatter / renderer のみテスト
- E2E は入れない

## 最終提案

今回の前提なら、以下が最もバランスがよい。

- Runtime: `Node.js 22 LTS`
- Server: `Fastify` + `Zod`
- Web: `React` + `TypeScript` + `Vite`
- UI: `Material UI`
- Data fetching: `TanStack Query`
- Charts: `Apache ECharts`
- Tests: `Vitest`
- Tooling: `pnpm` + `Biome`

これは「現行互換を保ちつつ分割できる」「UI 実装量を減らせる」「将来の分析可視化は伸ばせる」「依存を増やしすぎない」を同時に満たす。

## 参考ソース

以下は 2026-04-11 時点で確認した公式情報。

- React 19.2: https://react.dev/versions
- Vite 8.0 announcement: https://vite.dev/blog/announcing-vite8
- Node.js releases / LTS: https://nodejs.org/en/about/previous-releases
- Fastify docs: https://fastify.dev/docs/latest/Guides/Getting-Started/
- Material UI overview: https://mui.com/material-ui/getting-started/
- TanStack Query overview: https://tanstack.com/query/latest/docs/framework/react/overview
- Apache ECharts get started: https://echarts.apache.org/handbook/en/get-started/
- Biome overview: https://biomejs.dev/
- React Flow licensing context:
  - https://reactflow.dev/
  - https://github.com/xyflow/xyflow/blob/main/packages/react/LICENSE
