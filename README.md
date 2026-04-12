# cc-usage-viewer

Claude Code のセッションログを可視化するローカルビューアです。  
`~/.claude/projects/` 配下の JSONL を読み込み、チャット表示とトークン使用量の分析ができます。

## 起動方法

### 前提条件

- [Node.js](https://nodejs.org/) v18 以上
- [pnpm](https://pnpm.io/) v10 以上

### セットアップ

```bash
# リポジトリをクローン
git clone <repo-url>
cd cc-usage-viewer

# 依存パッケージをインストール
pnpm install
```

### 開発サーバーの起動

```bash
pnpm dev
```

サーバー（ポート `3000`）とフロントエンド（ポート `5173`）が同時に起動します。  
ブラウザで http://localhost:5173 を開いてください。

### 個別起動

```bash
# バックエンドのみ
pnpm dev:server

# フロントエンドのみ
pnpm dev:web
```

### ポートの変更

バックエンドのポートは環境変数で変更できます。

```bash
PORT=8080 pnpm dev:server
```

## プロジェクト構成

```
cc-usage-viewer/
├── apps/
│   ├── server/   # Fastify バックエンド (API サーバー)
│   └── web/      # React フロントエンド (Vite)
└── packages/
    └── shared/   # 型定義など共通コード
```

## その他のコマンド

```bash
pnpm build    # 全パッケージをビルド
pnpm test     # 全パッケージのテストを実行
pnpm lint     # Biome でリントチェック
pnpm format   # Biome でフォーマット
```
