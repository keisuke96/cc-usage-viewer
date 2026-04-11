# cc-usage-viewer

Claude Code のセッションログを可視化するローカルビューアです。

## 使い方

```bash
python3 token_viewer.py [--port 8765] [--no-browser]
```

`~/.claude/projects/` 配下の JSONL を読み込み、チャット表示と使用量分析を行います。
