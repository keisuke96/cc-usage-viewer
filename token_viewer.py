#!/usr/bin/env python3
"""
Claude Code トークン使用量ビューア

使い方:
  python3 token_viewer.py [--port 8765] [--no-browser]
"""

from __future__ import annotations

import json
import os
import re
import glob
import argparse
import threading
import webbrowser
from collections import defaultdict
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional
from urllib.parse import urlparse, parse_qs

PROJECTS_DIR = os.path.expanduser("~/.claude/projects")

# ============================================================
# 料金表 (USD per 1M tokens) — 2025年4月時点の概算
# ============================================================
PRICING = {
    "claude-opus-4": {
        "input": 15.0, "output": 75.0,
        "cache_write_5m": 18.75, "cache_write_1h": 22.5, "cache_read": 1.50,
    },
    "claude-sonnet-4": {
        "input": 3.0, "output": 15.0,
        "cache_write_5m": 3.75, "cache_write_1h": 4.50, "cache_read": 0.30,
    },
    "claude-haiku-4": {
        "input": 0.80, "output": 4.0,
        "cache_write_5m": 1.0, "cache_write_1h": 1.20, "cache_read": 0.08,
    },
}


def get_pricing(model: str) -> Optional[dict]:
    for prefix, pricing in PRICING.items():
        if prefix in model:
            return pricing
    return None


# ============================================================
# JSONL 解析・集計（分析用）
# ============================================================

def load_jsonl_for_analysis(path: str) -> list:
    records = {}
    no_id = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = obj.get("message", {})
                if not isinstance(msg, dict) or not msg.get("usage"):
                    continue
                rid = obj.get("requestId")
                if rid:
                    records[rid] = obj
                else:
                    no_id.append(obj)
    except (FileNotFoundError, PermissionError):
        pass
    return list(records.values()) + no_id


def aggregate(records: list) -> dict:
    by_model: dict = defaultdict(lambda: {
        "input_tokens": 0, "output_tokens": 0,
        "cache_creation_5m": 0, "cache_creation_1h": 0,
        "cache_read_tokens": 0, "requests": 0,
        "latest_total_input_tokens": 0,
        "latest_output_tokens": 0,
    })
    total = {
        "input_tokens": 0, "output_tokens": 0,
        "cache_creation_5m": 0, "cache_creation_1h": 0,
        "cache_read_tokens": 0, "requests": 0,
        "latest_total_input_tokens": 0,
        "latest_output_tokens": 0,
    }
    server_tool_use = {"web_search_requests": 0, "web_fetch_requests": 0}
    timestamps = []
    latest_by_model_ts: dict = {}
    latest_total_ts: Optional[str] = None

    for obj in records:
        msg = obj.get("message", {})
        usage = msg.get("usage", {})
        model = msg.get("model") or "unknown"
        # <synthetic> はサブエージェント spawn 時の内部ダミーレコード — スキップ
        if model.startswith("<") and model.endswith(">"):
            continue
        ts = obj.get("timestamp")
        if ts:
            timestamps.append(ts)

        cc = usage.get("cache_creation", {})
        stats = {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "cache_creation_5m": cc.get("ephemeral_5m_input_tokens", 0),
            "cache_creation_1h": cc.get("ephemeral_1h_input_tokens", 0),
            "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
        }
        latest_total_input = (
            stats["input_tokens"]
            + stats["cache_creation_5m"]
            + stats["cache_creation_1h"]
            + stats["cache_read_tokens"]
        )
        stool = usage.get("server_tool_use", {})
        server_tool_use["web_search_requests"] += stool.get("web_search_requests", 0)
        server_tool_use["web_fetch_requests"] += stool.get("web_fetch_requests", 0)

        m = by_model[model]
        for k, v in stats.items():
            m[k] += v
            total[k] += v
        m["requests"] += 1
        total["requests"] += 1
        if ts:
            if model not in latest_by_model_ts or ts >= latest_by_model_ts[model]:
                latest_by_model_ts[model] = ts
                m["latest_total_input_tokens"] = latest_total_input
                m["latest_output_tokens"] = stats["output_tokens"]
            if latest_total_ts is None or ts >= latest_total_ts:
                latest_total_ts = ts
                total["latest_total_input_tokens"] = latest_total_input
                total["latest_output_tokens"] = stats["output_tokens"]
        else:
            if m["latest_total_input_tokens"] == 0:
                m["latest_total_input_tokens"] = latest_total_input
                m["latest_output_tokens"] = stats["output_tokens"]
            if total["latest_total_input_tokens"] == 0:
                total["latest_total_input_tokens"] = latest_total_input
                total["latest_output_tokens"] = stats["output_tokens"]

    return {
        "by_model": {k: dict(v) for k, v in by_model.items()},
        "total": total,
        "server_tool_use": server_tool_use,
        "time_range": [min(timestamps), max(timestamps)] if timestamps else [None, None],
    }


def calc_cost(stats: dict, model: str) -> Optional[float]:
    p = get_pricing(model)
    if not p:
        return None
    return (
        stats["input_tokens"] * p["input"]
        + stats["output_tokens"] * p["output"]
        + stats["cache_creation_5m"] * p["cache_write_5m"]
        + stats["cache_creation_1h"] * p["cache_write_1h"]
        + stats["cache_read_tokens"] * p["cache_read"]
    ) / 1_000_000


def cache_hit_rate(stats: dict) -> float:
    total = (
        stats["input_tokens"] + stats["cache_read_tokens"]
        + stats["cache_creation_5m"] + stats["cache_creation_1h"]
    )
    return stats["cache_read_tokens"] / total * 100 if total else 0.0


def _enrich_agg(agg: dict) -> dict:
    """by_model / total にコスト・ヒット率を付加する（in-place で返す）。"""
    total_cost = 0.0
    has_unknown = False
    for model, stats in agg["by_model"].items():
        c = calc_cost(stats, model)
        stats["cost_usd"] = c
        stats["cache_hit_rate"] = cache_hit_rate(stats)
        if c is None:
            has_unknown = True
        else:
            total_cost += c
    agg["total"]["cost_usd"] = None if has_unknown else total_cost
    agg["total"]["cache_hit_rate"] = cache_hit_rate(agg["total"])
    return agg


def analyze_files(paths: list) -> dict:
    all_records = []
    for p in paths:
        all_records.extend(load_jsonl_for_analysis(p))
    return _enrich_agg(aggregate(all_records))


def analyze_structured(sessions_input: list, safe_fn) -> dict:
    """
    セッション単位の構造化分析。
    sessions_input: [{session_id, label, session_file|None, subagents:[{agent_id,agent_type,file}]}]
    safe_fn: パスの安全性検証関数 (str -> str|None)
    """
    result_sessions = []
    grand = {"input_tokens": 0, "output_tokens": 0, "cache_creation_5m": 0,
             "cache_creation_1h": 0, "cache_read_tokens": 0, "requests": 0,
             "cost_usd": 0.0, "latest_total_input_tokens": 0, "latest_output_tokens": 0}
    grand_ts_list: list = []

    for s in sessions_input:
        sf = safe_fn(s.get("session_file") or "") if s.get("session_file") else None

        # セッション本体
        if sf:
            session_agg = _enrich_agg(aggregate(load_jsonl_for_analysis(sf)))
            session_timeline = extract_usage_timeline(sf)
        else:
            session_agg = None
            session_timeline = []

        # サブエージェントごと
        sub_results = []
        for a in s.get("subagents", []):
            af = safe_fn(a.get("file") or "") if a.get("file") else None
            if not af:
                continue
            sub_agg = _enrich_agg(aggregate(load_jsonl_for_analysis(af)))
            sub_results.append({
                "agent_id": a.get("agent_id", ""),
                "agent_type": a.get("agent_type", ""),
                "by_model": sub_agg["by_model"],
                "total": sub_agg["total"],
                "usage_timeline": extract_usage_timeline(af),
            })

        # セッション + サブエージェント合算
        all_paths = ([sf] if sf else []) + [
            safe_fn(a.get("file") or "")
            for a in s.get("subagents", [])
            if a.get("file") and safe_fn(a.get("file") or "")
        ]
        combined_agg = _enrich_agg(aggregate(
            [r for p in all_paths for r in load_jsonl_for_analysis(p)]
        )) if all_paths else {"by_model": {}, "total": _zero_total()}

        # ツール使用統計
        ts_main = extract_tool_stats(sf) if sf else {"tool_counts": {}, "tool_errors": 0, "tool_results_total": 0}
        ts_subs = [
            extract_tool_stats(safe_fn(a.get("file") or ""))
            for a in s.get("subagents", [])
            if a.get("file") and safe_fn(a.get("file") or "")
        ]
        combined_ts = merge_tool_stats([ts_main] + ts_subs)
        grand_ts_list.append(combined_ts)

        result_sessions.append({
            "session_id": s.get("session_id", ""),
            "label": s.get("label", ""),
            "session": {"by_model": session_agg["by_model"], "total": session_agg["total"]} if session_agg else None,
            "usage_timeline": session_timeline,
            "subagents": sub_results,
            "combined": {"by_model": combined_agg["by_model"], "total": combined_agg["total"]},
            "tool_stats": combined_ts,
        })

        ct = combined_agg["total"]
        for k in ("input_tokens", "output_tokens", "cache_creation_5m",
                  "cache_creation_1h", "cache_read_tokens", "requests"):
            grand[k] += ct.get(k, 0)
        grand["cost_usd"] = (grand["cost_usd"] or 0) + (ct.get("cost_usd") or 0)
        grand["latest_total_input_tokens"] = max(
            grand["latest_total_input_tokens"],
            ct.get("latest_total_input_tokens", 0),
        )
        grand["latest_output_tokens"] = max(
            grand["latest_output_tokens"],
            ct.get("latest_output_tokens", 0),
        )

    grand["cache_hit_rate"] = cache_hit_rate(grand)
    return {"sessions": result_sessions, "grand_total": grand, "grand_tool_stats": merge_tool_stats(grand_ts_list)}


def _zero_total() -> dict:
    return {"input_tokens": 0, "output_tokens": 0, "cache_creation_5m": 0,
            "cache_creation_1h": 0, "cache_read_tokens": 0, "requests": 0,
            "cost_usd": 0.0, "cache_hit_rate": 0.0,
            "latest_total_input_tokens": 0, "latest_output_tokens": 0}


# ============================================================
# ツール使用統計
# ============================================================

_BASH_SEPARATORS = re.compile(r'&&|\|\||[;|\n]')
_ENV_PREFIX = re.compile(r'^(?:[A-Z_][A-Z_0-9]*=\S*\s+)+')
_SKIP_CMDS = frozenset({
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done',
    'case', 'esac', 'echo', 'printf', 'true', 'false', '[', '[[', 'test',
    'local', 'export', 'unset', 'set', 'read',
})


def _parse_bash_cmds(command: str) -> list:
    """Bash コマンド文字列から実行コマンド名のリストを返す。連結・パイプを分割し先頭語を抽出。"""
    cmds = []
    for part in _BASH_SEPARATORS.split(command):
        part = part.strip()
        if not part or part.startswith('#'):
            continue
        # 先頭の環境変数定義 (KEY=val) を除去
        part = _ENV_PREFIX.sub('', part).strip()
        words = part.split()
        if not words:
            continue
        name = words[0].split('/')[-1]  # /usr/bin/git → git
        if name and name not in _SKIP_CMDS and name.isidentifier():
            cmds.append(name)
    return cmds


def extract_tool_stats(path: str) -> dict:
    """JSONL からツール呼び出し回数・エラー数・Bash/Skill/Agent 内訳を集計する。"""
    tool_counts: dict = defaultdict(int)
    bash_commands: dict = defaultdict(int)
    skill_calls: dict = defaultdict(int)
    agent_calls: dict = defaultdict(int)
    tool_errors = 0
    tool_results_total = 0
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = obj.get("message", {})
                if not isinstance(msg, dict):
                    continue
                content = msg.get("content", [])
                if not isinstance(content, list):
                    continue
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "tool_use":
                        name = item.get("name", "unknown")
                        tool_counts[name] += 1
                        inp = item.get("input") or {}
                        if name == "Bash":
                            for subcmd in _parse_bash_cmds(inp.get("command", "")):
                                bash_commands[subcmd] += 1
                        elif name == "Skill":
                            key = inp.get("skill") or "unknown"
                            skill_calls[key] += 1
                        elif name == "Agent":
                            key = (inp.get("subagent_type")
                                   or (inp.get("description") or "")[:40]
                                   or "general-purpose")
                            agent_calls[key] += 1
                    elif item.get("type") == "tool_result":
                        tool_results_total += 1
                        if item.get("is_error"):
                            tool_errors += 1
    except (FileNotFoundError, PermissionError):
        pass
    return {
        "tool_counts": dict(tool_counts),
        "bash_commands": dict(bash_commands),
        "skill_calls": dict(skill_calls),
        "agent_calls": dict(agent_calls),
        "tool_errors": tool_errors,
        "tool_results_total": tool_results_total,
    }


def merge_tool_stats(stats_list: list) -> dict:
    merged: dict = defaultdict(int)
    merged_bash: dict = defaultdict(int)
    merged_skill: dict = defaultdict(int)
    merged_agent: dict = defaultdict(int)
    total_errors = 0
    total_results = 0
    for s in stats_list:
        for k, v in s.get("tool_counts", {}).items():
            merged[k] += v
        for k, v in s.get("bash_commands", {}).items():
            merged_bash[k] += v
        for k, v in s.get("skill_calls", {}).items():
            merged_skill[k] += v
        for k, v in s.get("agent_calls", {}).items():
            merged_agent[k] += v
        total_errors += s.get("tool_errors", 0)
        total_results += s.get("tool_results_total", 0)
    return {
        "tool_counts": dict(merged),
        "bash_commands": dict(merged_bash),
        "skill_calls": dict(merged_skill),
        "agent_calls": dict(merged_agent),
        "tool_errors": total_errors,
        "tool_results_total": total_results,
    }


# ============================================================
# エージェントグラフ抽出
# ============================================================

def extract_agent_graph(path: str) -> dict:
    """メインセッションJSONLからエージェントの関係グラフを抽出する。"""
    records = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except (FileNotFoundError, PermissionError):
        return {"agents": [], "teams": {}, "messages": [], "completions": {}}

    # Pass 1: tool_use items をIDごとに収集
    tool_use_by_id: dict = {}
    for obj in records:
        ts = obj.get("timestamp", "")
        msg = obj.get("message", {})
        if not isinstance(msg, dict):
            continue
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool_use":
                tuid = item.get("id", "")
                if tuid:
                    tool_use_by_id[tuid] = {
                        "name": item.get("name", ""),
                        "input": item.get("input", {}),
                        "timestamp": ts,
                    }

    agents: dict = {}
    teams: dict = {}

    # Pass 2: tool_result と照合
    for obj in records:
        msg = obj.get("message", {})
        if not isinstance(msg, dict):
            continue
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "tool_result":
                continue
            tuid = item.get("tool_use_id", "")
            tu = tool_use_by_id.get(tuid)
            if not tu:
                continue

            rc = item.get("content", "")
            if isinstance(rc, list):
                result_text = "\n".join(x.get("text", "") for x in rc if isinstance(x, dict))
            else:
                result_text = str(rc)

            if tu["name"] == "Agent":
                inp = tu["input"]
                m1 = re.search(r"agentId:\s*(\w+)", result_text)
                m2 = re.search(r"agent_id:\s*([\w@\-]+)", result_text)
                agent_id = ""
                if m1:
                    agent_id = m1.group(1)
                elif m2:
                    agent_id = m2.group(1)
                agents[tuid] = {
                    "tool_use_id": tuid,
                    "agent_id": agent_id,
                    "name": inp.get("name", ""),
                    "description": inp.get("description", ""),
                    "team_name": inp.get("team_name", "") or "",
                    "run_in_background": inp.get("run_in_background", False),
                    "subagent_type": inp.get("subagent_type", ""),
                    "prompt": inp.get("prompt", ""),
                    "timestamp": tu["timestamp"],
                    "completion": None,
                }

            elif tu["name"] == "TeamCreate":
                inp = tu["input"]
                team_name = inp.get("team_name", "")
                if team_name:
                    teams[team_name] = {
                        "team_name": team_name,
                        "description": inp.get("description", ""),
                        "timestamp": tu["timestamp"],
                    }

    # SendMessage 収集
    send_messages = []
    for tuid, tu in tool_use_by_id.items():
        if tu["name"] == "SendMessage":
            inp = tu["input"]
            msg_content = inp.get("message", {})
            msg_type = inp.get("type", "")
            if not msg_type and isinstance(msg_content, dict):
                msg_type = msg_content.get("type", "")
            send_messages.append({
                "to": inp.get("to", "") or inp.get("recipient", ""),
                "message_type": msg_type,
                "timestamp": tu["timestamp"],
            })

    # queue-operation から完了情報収集
    completions: dict = {}
    for obj in records:
        if obj.get("type") == "queue-operation" and obj.get("operation") == "enqueue":
            content_str = obj.get("content", "")
            m_id = re.search(r"<task-id>(\w+)</task-id>", content_str)
            m_st = re.search(r"<status>(\w+)</status>", content_str)
            m_su = re.search(r"<summary>(.*?)</summary>", content_str, re.DOTALL)
            if m_id:
                task_id = m_id.group(1)
                completions[task_id] = {
                    "task_id": task_id,
                    "status": m_st.group(1) if m_st else "unknown",
                    "summary": (m_su.group(1).strip() if m_su else "")[:200],
                    "timestamp": obj.get("timestamp", ""),
                }

    # エージェントに完了情報を付加
    for tuid, agent in agents.items():
        agent_id = agent.get("agent_id", "")
        if agent_id in completions:
            agent["completion"] = completions[agent_id]
        else:
            for task_id, comp in completions.items():
                if agent_id and task_id and agent_id[:8] == task_id[:8]:
                    agent["completion"] = comp
                    break

    # サブエージェントJSONLパスを付加
    session_dir = path.replace(".jsonl", "")
    subagents_dir = os.path.join(session_dir, "subagents")
    project_dir = os.path.dirname(path)

    # プロジェクト内の他セッションの「最初のユーザーメッセージ」をキャッシュ
    # チームエージェント照合に使う
    peer_sessions: dict = {}  # session_file -> first_user_content
    for sess_file in glob.glob(os.path.join(project_dir, "*.jsonl")):
        if sess_file == path:
            continue
        try:
            with open(sess_file, encoding="utf-8") as sf:
                for sline in sf:
                    sline = sline.strip()
                    if not sline:
                        continue
                    sobj = json.loads(sline)
                    if sobj.get("type") != "user":
                        continue
                    smsg = sobj.get("message", {})
                    scontent = smsg.get("content", "")
                    if isinstance(scontent, str) and "<teammate-message" in scontent:
                        peer_sessions[sess_file] = scontent
                    break
        except Exception:
            pass

    for tuid, agent in agents.items():
        agent_id = agent.get("agent_id", "")
        if agent_id and "@" not in agent_id:
            # スタンドアロン: subagents/ ディレクトリから検索
            jsonl_path = os.path.join(subagents_dir, f"agent-{agent_id}.jsonl")
            if os.path.exists(jsonl_path):
                agent["jsonl_path"] = jsonl_path
        elif agent_id and "@" in agent_id:
            # チームエージェント: プロンプト先頭30文字でピアセッションを照合
            prompt_key = agent.get("prompt", "")[:40].strip()
            if prompt_key:
                for sess_file, first_content in peer_sessions.items():
                    if prompt_key in first_content:
                        agent["jsonl_path"] = sess_file
                        break

    return {
        "agents": list(agents.values()),
        "teams": teams,
        "messages": send_messages,
        "completions": completions,
    }


# ============================================================
# チャット履歴パース
# ============================================================

_SKIP_PREFIXES = (
    "<local-command-caveat>",
    "<command-name>",
    "<system-reminder>",
    "<system>",
    "<function_calls>",
)

def _parse_content_item(c: dict) -> Optional[dict]:
    ctype = c.get("type")
    if ctype == "text":
        text = c.get("text", "").strip()
        return {"type": "text", "text": text} if text else None
    if ctype == "thinking":
        text = c.get("thinking", "").strip()
        return {"type": "thinking", "text": text} if text else None
    if ctype == "tool_use":
        return {
            "type": "tool_use",
            "tool_name": c.get("name", ""),
            "input": c.get("input", {}),
        }
    if ctype == "tool_result":
        rc = c.get("content", "")
        if isinstance(rc, list):
            rc = "\n".join(
                x.get("text", "") for x in rc if isinstance(x, dict)
            )
        return {
            "type": "tool_result",
            "content": str(rc),
            "is_error": bool(c.get("is_error")),
        }
    return None


def parse_chat(path: str) -> list:
    """JSOLをチャット表示用メッセージリストに変換する。"""
    by_uuid: dict = {}
    uuid_order: list = []

    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                uid = obj.get("uuid")
                if uid:
                    if uid not in by_uuid:
                        uuid_order.append(uid)
                    by_uuid[uid] = obj  # 最後の出現で上書き（完全版）
    except (FileNotFoundError, PermissionError):
        return []

    messages = []
    for uid in uuid_order:
        obj = by_uuid[uid]
        t = obj.get("type")
        msg = obj.get("message", {})
        role = msg.get("role")

        if t not in ("user", "assistant") or not role:
            continue

        content = msg.get("content", "")
        parsed: list = []

        if isinstance(content, str):
            text = content.strip()
            if not text:
                continue
            # システム注入をスキップ
            if any(text.startswith(p) for p in _SKIP_PREFIXES):
                continue
            # <local-command-stdout> を tool_result として扱う
            m = re.search(r"<local-command-stdout>(.*?)</local-command-stdout>", text, re.DOTALL)
            if m:
                parsed.append({"type": "tool_result", "content": m.group(1).strip(), "is_error": False})
            else:
                parsed.append({"type": "text", "text": text})

        elif isinstance(content, list):
            for c in content:
                if isinstance(c, dict):
                    item = _parse_content_item(c)
                    if item:
                        parsed.append(item)

        if not parsed:
            continue

        messages.append({
            "role": role,
            "content": parsed,
            "timestamp": obj.get("timestamp"),
            "model": msg.get("model"),
        })

    return messages


def _content_types_for_usage(msg: dict) -> list:
    content = msg.get("content", [])
    if isinstance(content, list):
        seen = []
        for item in content:
            if not isinstance(item, dict):
                continue
            ctype = item.get("type")
            if not ctype:
                continue
            label = "text" if ctype == "text" else ctype
            if label not in seen:
                seen.append(label)
        return seen
    if isinstance(content, str) and content.strip():
        return ["text"]
    return []


def _summarize_user_content(msg: dict) -> str:
    content = msg.get("content", "")
    text = ""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        text = "\n".join(parts)
    text = text.strip()
    if not text or any(text.startswith(p) for p in _SKIP_PREFIXES):
        return ""
    one_line = " ".join(line.strip() for line in text.splitlines() if line.strip())
    return one_line[:80]


def extract_usage_timeline(path: str) -> list:
    """JSONL から各リクエストの Token Usage 推移を抽出する。"""
    points_by_id: dict = {}
    seq = 0
    latest_user_summary = ""

    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = obj.get("message", {})
                if not isinstance(msg, dict):
                    continue
                if obj.get("type") == "user":
                    summary = _summarize_user_content(msg)
                    if summary:
                        latest_user_summary = summary
                usage = msg.get("usage", {})
                if not usage:
                    continue
                model = msg.get("model") or "unknown"
                if model.startswith("<") and model.endswith(">"):
                    continue

                cc = usage.get("cache_creation", {})
                cache_write = (
                    cc.get("ephemeral_5m_input_tokens", 0)
                    + cc.get("ephemeral_1h_input_tokens", 0)
                )
                total_input = (
                    usage.get("input_tokens", 0)
                    + usage.get("cache_read_input_tokens", 0)
                    + cache_write
                )
                point = {
                    "timestamp": obj.get("timestamp"),
                    "model": model,
                    "input_tokens": usage.get("input_tokens", 0),
                    "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
                    "cache_write_tokens": cache_write,
                    "total_input_tokens": total_input,
                    "output_tokens": usage.get("output_tokens", 0),
                    "token_usage": total_input + usage.get("output_tokens", 0),
                    "content_types": _content_types_for_usage(msg),
                    "user_summary": latest_user_summary,
                    "_seq": seq,
                }
                seq += 1

                key = obj.get("requestId") or obj.get("uuid") or f"line-{seq}"
                prev = points_by_id.get(key)
                if not prev:
                    points_by_id[key] = point
                    continue
                merged_types = prev.get("content_types", [])
                for label in point.get("content_types", []):
                    if label not in merged_types:
                        merged_types.append(label)
                point["content_types"] = merged_types
                if not point.get("user_summary"):
                    point["user_summary"] = prev.get("user_summary", "")
                prev_ts = prev.get("timestamp") or ""
                curr_ts = point.get("timestamp") or ""
                if (curr_ts and curr_ts >= prev_ts) or (not prev_ts and point["_seq"] >= prev["_seq"]):
                    points_by_id[key] = point
                else:
                    prev["content_types"] = merged_types
                    if not prev.get("user_summary"):
                        prev["user_summary"] = point.get("user_summary", "")
    except (FileNotFoundError, PermissionError):
        return []

    ordered = sorted(
        points_by_id.values(),
        key=lambda p: ((p.get("timestamp") or ""), p.get("_seq", 0)),
    )
    result = []
    for i, point in enumerate(ordered, start=1):
        point.pop("_seq", None)
        point["request_index"] = i
        result.append(point)
    return result


# ============================================================
# プロジェクト・セッション情報
# ============================================================

def project_display_name(project_id: str) -> str:
    name = re.sub(r"^-Users-[^-]+-", "", project_id)
    if not name:
        name = project_id
    return "~/" + name.lstrip("-")


def extract_first_user_message(jsonl_path: str) -> str:
    try:
        with open(jsonl_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "user":
                    continue
                msg = obj.get("message", {})
                content = msg.get("content", "")
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            text = c.get("text", "")
                            break
                stripped = text.strip()
                if not stripped or any(stripped.startswith(p) for p in _SKIP_PREFIXES):
                    continue
                lines = stripped.splitlines()
                display_lines = []
                for ln in lines:
                    l = ln.strip()
                    if not l:
                        continue
                    # スラッシュコマンド (/commit, /help 等) はスキップ。
                    # ただし /Users/... のようなファイルパス（2つ目の / を含む）は除外しない。
                    if l.startswith("/") and " " not in l and "/" not in l[1:]:
                        continue
                    display_lines.append(l)
                result = " ".join(display_lines)
                if result:
                    return result[:120]
    except (FileNotFoundError, PermissionError):
        pass
    return ""


def get_projects() -> list:
    projects = []
    if not os.path.isdir(PROJECTS_DIR):
        return projects

    for entry in sorted(os.scandir(PROJECTS_DIR), key=lambda e: e.name):
        if not entry.is_dir() or entry.name == "memory":
            continue
        project_id = entry.name
        project_path = entry.path
        jsonl_files = glob.glob(os.path.join(project_path, "*.jsonl"))
        index_path = os.path.join(project_path, "sessions-index.json")
        original_path = None
        if os.path.exists(index_path):
            try:
                with open(index_path) as f:
                    idx = json.load(f)
                    original_path = idx.get("originalPath")
            except Exception:
                pass
        display = original_path or project_display_name(project_id)
        projects.append({
            "id": project_id,
            "display_name": display,
            "path": project_path,
            "session_count": len(jsonl_files),
        })

    return projects


def _check_team_session(jsonl_path: str) -> tuple:
    """セッションがチームエージェントセッションか判定。(is_team, prompt_prefix) を返す。"""
    try:
        with open(jsonl_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "user":
                    continue
                msg = obj.get("message", {})
                content = msg.get("content", "")
                if isinstance(content, str) and "<teammate-message" in content:
                    m = re.search(r"<teammate-message[^>]*>\n?(.*)", content, re.DOTALL)
                    prompt = (m.group(1).strip() if m else content)[:60]
                    return True, prompt
                return False, ""
    except Exception:
        pass
    return False, ""


def _has_team_create(jsonl_path: str) -> bool:
    """TeamCreate ツール呼び出しがあるか高速チェック。"""
    try:
        with open(jsonl_path, encoding="utf-8") as f:
            for line in f:
                if '"TeamCreate"' in line:
                    return True
    except Exception:
        pass
    return False


def get_sessions(project_id: str) -> list:
    project_path = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.isdir(project_path):
        return []

    index_path = os.path.join(project_path, "sessions-index.json")
    index_by_id: dict = {}
    if os.path.exists(index_path):
        try:
            with open(index_path) as f:
                idx = json.load(f)
            for entry in idx.get("entries", []):
                index_by_id[entry["sessionId"]] = entry
        except Exception:
            pass

    jsonl_files = glob.glob(os.path.join(project_path, "*.jsonl"))
    sessions = []

    for jsonl_path in jsonl_files:
        basename = os.path.basename(jsonl_path)
        session_id = basename.replace(".jsonl", "")
        session_dir = os.path.join(project_path, session_id)

        subagents = []
        subagents_dir = os.path.join(session_dir, "subagents")
        if os.path.isdir(subagents_dir):
            for agent_file in sorted(glob.glob(os.path.join(subagents_dir, "*.jsonl"))):
                agent_id = os.path.basename(agent_file).replace(".jsonl", "")
                meta_path = agent_file.replace(".jsonl", ".meta.json")
                agent_type = "general-purpose"
                description = ""
                if os.path.exists(meta_path):
                    try:
                        with open(meta_path) as f:
                            meta = json.load(f)
                            agent_type = meta.get("agentType", "general-purpose")
                            description = meta.get("description", "")
                    except Exception:
                        pass
                subagents.append({
                    "agent_id": agent_id,
                    "jsonl_path": agent_file,
                    "agent_type": agent_type,
                    "description": description,
                })

        if session_id in index_by_id:
            entry = index_by_id[session_id]
            summary = entry.get("summary") or entry.get("firstPrompt") or ""
            timestamp = entry.get("created") or entry.get("modified")
            first_message = summary
        else:
            first_message = extract_first_user_message(jsonl_path)
            try:
                mtime = os.path.getmtime(jsonl_path)
                timestamp = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
            except Exception:
                timestamp = None

        sessions.append({
            "session_id": session_id,
            "jsonl_path": jsonl_path,
            "timestamp": timestamp,
            "first_message": first_message,
            "subagents": subagents,
        })

    sessions.sort(key=lambda s: s.get("timestamp") or "", reverse=True)

    # ---- チームセッションの関連付け ----
    # Pass 1: チームエージェントセッション（<teammate-message>で始まる）を特定
    team_prompt_map: dict = {}  # jsonl_path -> (session_id, prompt_prefix)
    for s in sessions:
        is_team, prompt = _check_team_session(s["jsonl_path"])
        s["_is_team"] = is_team
        if is_team:
            team_prompt_map[s["jsonl_path"]] = (s["session_id"], prompt)

    # Pass 2: 親セッションにチームセッションを紐付け
    for s in sessions:
        s["team_sessions"] = []
        if s["_is_team"] or not _has_team_create(s["jsonl_path"]):
            continue
        graph = extract_agent_graph(s["jsonl_path"])
        for agent in graph["agents"]:
            if not agent.get("team_name"):
                continue
            agent_jsonl = agent.get("jsonl_path", "")
            if agent_jsonl and agent_jsonl in team_prompt_map:
                ts_id, _ = team_prompt_map[agent_jsonl]
                s["team_sessions"].append({
                    "session_id": ts_id,
                    "jsonl_path": agent_jsonl,
                    "description": agent.get("description", ""),
                    "name": agent.get("name", ""),
                    "team_name": agent.get("team_name", ""),
                })

    # Pass 3: チームセッションをトップレベルから除外
    sessions = [s for s in sessions if not s.pop("_is_team")]

    return sessions


# ============================================================
# HTTP サーバー
# ============================================================

HTML = r"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Token Viewer</title>
<style>
  :root {
    --bg: #0f1117; --bg2: #161b22; --bg3: #21262d; --bg4: #2d333b;
    --border: #30363d; --border2: #3d444d;
    --text: #e6edf3; --text2: #8b949e; --text3: #6e7681;
    --accent: #58a6ff; --accent2: #1f6feb;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
    --purple: #bc8cff; --orange: #ffa657; --teal: #39d353;
    --radius: 8px; --sidebar-w: 240px; --sessions-w: 320px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: var(--bg); color: var(--text); height: 100vh;
         display: flex; flex-direction: column; overflow: hidden; }

  /* Header */
  header { background: var(--bg2); border-bottom: 1px solid var(--border);
           padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  header h1 { font-size: 14px; font-weight: 600; }
  .header-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  #selected-count { font-size: 12px; color: var(--text2); }
  .btn { background: var(--accent2); color: #fff; border: none; border-radius: 6px;
         padding: 5px 12px; font-size: 12px; cursor: pointer; font-weight: 500; transition: opacity .15s; }
  .btn:hover { opacity: .85; }
  .btn:disabled { opacity: .35; cursor: default; }

  /* Layout */
  .app { display: flex; flex: 1; overflow: hidden; }

  /* Sidebar */
  .sidebar { width: var(--sidebar-w); background: var(--bg2); border-right: 1px solid var(--border);
             display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
  .pane-header { padding: 8px 12px; font-size: 11px; font-weight: 600; color: var(--text2);
                 text-transform: uppercase; letter-spacing: .06em; border-bottom: 1px solid var(--border);
                 display: flex; align-items: center; gap: 6px; }
  .sidebar-list { overflow-y: auto; flex: 1; }
  .project-item { padding: 8px 12px; cursor: pointer; font-size: 12px;
                  border-left: 3px solid transparent; transition: background .1s;
                  display: flex; flex-direction: column; gap: 2px; }
  .project-item:hover { background: var(--bg3); }
  .project-item.active { border-left-color: var(--accent); background: var(--bg3); }
  .project-name { color: var(--text); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .project-count { font-size: 10px; color: var(--text2); }

  /* Sessions panel */
  .sessions-panel { width: var(--sessions-w); background: var(--bg); border-right: 1px solid var(--border);
                    display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
  .sessions-toolbar { padding: 6px 10px; border-bottom: 1px solid var(--border);
                      display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .sessions-toolbar-title { font-size: 12px; font-weight: 600; flex: 1;
                             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .link-btn { font-size: 11px; color: var(--accent); cursor: pointer; background: none;
              border: none; padding: 0; white-space: nowrap; }
  .link-btn:hover { text-decoration: underline; }
  .sessions-list { overflow-y: auto; flex: 1; }

  /* Session items */
  .session-item { border-bottom: 1px solid var(--border); display: flex;
                  gap: 8px; align-items: flex-start; transition: background .1s; }
  .session-item:hover { background: var(--bg3); }
  .session-item.chat-active { background: rgba(88,166,255,.06); border-left: 2px solid var(--accent); }
  .session-item.selected { background: rgba(88,166,255,.05); }
  .session-check-wrap { padding: 10px 0 10px 10px; }
  .session-check { accent-color: var(--accent); width: 13px; height: 13px; cursor: pointer; margin-top: 1px; }
  .session-body { flex: 1; padding: 9px 10px 9px 0; cursor: pointer; min-width: 0; }
  .session-msg { font-size: 12px; color: var(--text); white-space: nowrap;
                 overflow: hidden; text-overflow: ellipsis; margin-bottom: 3px; }
  .session-meta { font-size: 10px; color: var(--text2); display: flex; gap: 6px; align-items: center; }
  .badge { background: var(--bg3); border: 1px solid var(--border); border-radius: 3px;
           padding: 1px 4px; font-size: 10px; color: var(--text2); }

  /* Project overview row */
  .project-overview-row { padding: 9px 10px; cursor: pointer; border-bottom: 1px solid var(--border);
                          display: flex; align-items: center; gap: 8px; transition: background .1s; }
  .project-overview-row:hover { background: var(--bg3); }
  .project-overview-row.active { background: rgba(88,166,255,.08); border-left: 2px solid var(--accent); }
  .project-overview-label { font-size: 12px; font-weight: 600; color: var(--text2); }
  .project-overview-row.active .project-overview-label { color: var(--accent); }

  /* Subagent items */
  .subagent-item { border-bottom: 1px solid rgba(48,54,61,.4); display: flex;
                   gap: 8px; align-items: flex-start; transition: background .1s; }
  .subagent-item:hover { background: var(--bg3); }
  .subagent-item.chat-active { background: rgba(188,140,255,.06); border-left: 2px solid var(--purple); }
  .subagent-check-wrap { padding: 8px 0 8px 24px; }
  .subagent-body { flex: 1; padding: 7px 10px 7px 0; cursor: pointer; min-width: 0; display: flex; gap: 6px; align-items: center; }
  .subagent-icon { font-size: 10px; color: var(--purple); flex-shrink: 0; }
  .subagent-label { font-size: 11px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Right panel */
  .right-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

  /* Tabs */
  .tab-bar { display: flex; border-bottom: 1px solid var(--border); background: var(--bg2); flex-shrink: 0; }
  .tab { padding: 9px 16px; font-size: 12px; font-weight: 500; cursor: pointer; color: var(--text2);
         border-bottom: 2px solid transparent; transition: color .15s; user-select: none; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  /* Panel content */
  .panel-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .panel-body { flex: 1; overflow-y: auto; padding: 20px; }

  /* Empty state */
  .empty-state { display: flex; flex-direction: column; align-items: center;
                 justify-content: center; height: 100%; gap: 10px; color: var(--text2); }
  .empty-state .icon { font-size: 36px; opacity: .35; }
  .empty-state p { font-size: 13px; }

  /* ── Analysis ───────────────────────────── */
  .analysis-header { margin-bottom: 14px; }
  .analysis-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .time-range { font-size: 11px; color: var(--text2); }

  /* Grand total summary */
  .summary-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
                  padding: 14px 16px; margin-bottom: 16px; }
  .summary-title { font-size: 10px; font-weight: 700; color: var(--text2); text-transform: uppercase;
                   letter-spacing: .06em; margin-bottom: 12px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  .summary-stat { display: flex; flex-direction: column; gap: 3px; }
  .summary-stat-label { font-size: 10px; color: var(--text2); }
  .summary-stat-value { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .summary-stat-value.primary { color: var(--accent); }
  .summary-stat-value.green { color: var(--green); }
  .summary-stat-value.orange { color: var(--orange); }
  .summary-note { margin-top: 10px; font-size: 10px; color: var(--text3); line-height: 1.5; }

  /* Session cards */
  .session-cards { display: flex; flex-direction: column; gap: 12px; }
  .session-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .session-card-header { padding: 10px 14px; display: flex; align-items: center; gap: 8px;
                         border-bottom: 1px solid var(--border); }
  .session-card-label { font-size: 12px; font-weight: 600; flex: 1; min-width: 0;
                        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session-card-usage { font-size: 12px; font-weight: 700; color: var(--accent); white-space: nowrap; }
  .session-card-cost { font-size: 12px; font-weight: 700; color: var(--orange); white-space: nowrap; }
  .session-card-reqs { font-size: 10px; color: var(--text2); white-space: nowrap; }
  .session-card-body { padding: 10px 14px; }

  /* Model rows inside session card */
  .model-section { margin-bottom: 8px; }
  .model-section-label { font-size: 10px; color: var(--text3); text-transform: uppercase;
                         letter-spacing: .05em; margin-bottom: 6px; }
  .model-card { background: var(--bg3); border: 1px solid var(--border2); border-radius: 6px;
                padding: 8px 10px; margin-bottom: 8px; }
  .model-card:last-child { margin-bottom: 0; }
  .model-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .model-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .model-name-sm { font-size: 11px; color: var(--text); font-weight: 600; flex: 1; min-width: 0;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .model-card-meta { font-size: 10px; color: var(--text3); white-space: nowrap; }
  .model-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 6px; margin-bottom: 10px; }
  .model-metric { background: rgba(255,255,255,.02); border: 1px solid var(--border); border-radius: 5px; padding: 5px 6px; }
  .model-metric-label { font-size: 9px; color: var(--text3); margin-bottom: 2px; }
  .model-metric-value { font-size: 11px; color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .model-metric-value.green { color: var(--green); }
  .model-metric-value.orange { color: var(--orange); }
  .model-bar-group { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .model-bar-group:last-child { margin-bottom: 0; }
  .model-bar-label { font-size: 10px; color: var(--text2); width: 78px; flex-shrink: 0; }
  .token-bar-wrap { flex: 1; background: var(--bg2); border-radius: 4px; height: 8px; overflow: hidden; position: relative; }
  .token-bar { height: 100%; }
  .token-bar-stack { height: 100%; display: flex; overflow: hidden; }
  .token-segment { height: 100%; min-width: 0; }
  .token-value { font-size: 10px; color: var(--text); width: 168px; text-align: right;
                 flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .usage-trend-card { background: var(--bg3); border: 1px solid var(--border2); border-radius: 6px;
                      padding: 10px; margin-bottom: 10px; }
  .usage-trend-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .usage-trend-title { font-size: 11px; font-weight: 600; color: var(--text); flex: 1; }
  .usage-trend-meta { font-size: 10px; color: var(--text3); white-space: nowrap; }
  .usage-trend-legend { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .usage-legend-item { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--text2); }
  .usage-legend-swatch { width: 10px; height: 10px; border-radius: 2px; }
  .usage-trend-scroll { overflow-x: auto; padding-bottom: 4px; }
  .usage-trend-bars { display: flex; align-items: flex-end; gap: 6px; min-height: 156px; min-width: min-content; }
  .usage-trend-col { width: 24px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .usage-trend-bar-wrap { width: 100%; height: 132px; background: var(--bg2); border-radius: 4px; border: 1px solid var(--border);
                          display: flex; align-items: flex-end; overflow: hidden; }
  .usage-trend-bar { width: 100%; display: flex; flex-direction: column; justify-content: flex-end; min-height: 2px; }
  .usage-trend-input-raw { width: 100%; background: #58a6ff; }
  .usage-trend-cache-read { width: 100%; background: #3fb950; }
  .usage-trend-cache-write { width: 100%; background: #d29922; }
  .usage-trend-output { width: 100%; background: #f85149; }
  .usage-trend-turn { font-size: 9px; color: var(--text3); }

  /* Subagent section */
  .subagent-section { margin-top: 8px; border-top: 1px solid var(--border); }
  .subagent-title { padding: 7px 0 6px; font-size: 10px; color: var(--text2);
                    display: flex; align-items: center; gap: 5px; user-select: none; }
  .subagent-list { display: flex; flex-direction: column; gap: 6px; padding-bottom: 4px; }
  .subagent-card { background: var(--bg3); border: 1px solid var(--border2); border-radius: 6px;
                   padding: 8px 10px; }
  .subagent-card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .subagent-type-badge { font-size: 10px; color: var(--purple); font-weight: 600; flex: 1; }
  .subagent-cost { font-size: 10px; color: var(--orange); font-weight: 600; }

  /* Tool stat rows (analysis) */
  .tool-stat-row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
  .tool-stat-name { font-size: 11px; color: var(--text2); width: 110px; flex-shrink: 0;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tool-stat-count { font-size: 11px; color: var(--text); width: 36px; text-align: right;
                     flex-shrink: 0; font-variant-numeric: tabular-nums; }

  /* Tool insight callout */
  .tool-insight { font-size: 11px; padding: 6px 10px; border-radius: 5px; margin-top: 8px; line-height: 1.5; }
  .tool-insight.warn { background: rgba(255,166,87,.1); border: 1px solid rgba(255,166,87,.3); color: var(--orange); }
  .tool-insight.ok   { background: rgba(63,185,80,.1);  border: 1px solid rgba(63,185,80,.3);  color: var(--green); }

  /* Per-session tool section */
  .session-tool-section { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 6px; }
  .session-tool-title { font-size: 10px; color: var(--text2); display: flex;
                        align-items: center; gap: 5px; user-select: none; margin-bottom: 4px; }
  .session-tool-err-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; margin-left: auto; }
  .session-tool-err-badge.has-error { background: rgba(248,81,73,.15); color: var(--red); }
  .session-tool-err-badge.no-error  { background: rgba(63,185,80,.15);  color: var(--green); }

  /* ── Graph ──────────────────────────────── */
  .graph-body { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 20px; }
  .graph-section { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .graph-section-title { font-size: 10px; font-weight: 700; color: var(--text2); text-transform: uppercase;
                          letter-spacing: .06em; margin-bottom: 12px; }

  /* Tree */
  .graph-tree { display: flex; flex-direction: column; align-items: flex-start; gap: 0; }
  .orchestrator-node { background: var(--bg3); border: 1px solid var(--border2); border-radius: var(--radius);
                        padding: 10px 14px; display: flex; align-items: center; gap: 10px; min-width: 220px; }
  .tree-connector { width: 2px; height: 24px; background: var(--border2); margin-left: 20px; }
  .tree-children { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; padding-left: 20px;
                    border-left: 2px solid var(--border2); margin-left: 20px; padding-top: 12px; }
  .tree-child { display: flex; flex-direction: column; }

  /* Agent / Team nodes */
  .agent-node { background: var(--bg3); border: 1px solid var(--border2); border-radius: var(--radius);
                 padding: 10px 14px; display: flex; align-items: center; gap: 10px; min-width: 180px;
                 transition: border-color .15s, background .15s; }
  .agent-node.clickable { cursor: pointer; }
  .agent-node.clickable:hover { border-color: var(--purple); background: rgba(188,140,255,.06); }
  .agent-node.current { border-color: var(--purple); background: rgba(188,140,255,.10); }
  .agent-node-icon { font-size: 18px; flex-shrink: 0; }
  .agent-node-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .agent-node-name { font-size: 12px; font-weight: 600; color: var(--text);
                      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agent-node-id { font-size: 10px; color: var(--text3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agent-node-status { font-size: 10px; font-weight: 600; }
  .agent-node-link { font-size: 14px; color: var(--purple); flex-shrink: 0; }

  /* Team group */
  .team-group { border: 1px dashed var(--border2); border-radius: var(--radius); padding: 10px;
                 background: rgba(88,166,255,.03); }
  .team-group-header { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
  .team-icon { font-size: 13px; }
  .team-name { font-size: 11px; font-weight: 600; color: var(--accent); }
  .team-members { display: flex; flex-direction: column; gap: 8px; }

  /* Message flow */
  .message-flow-item { display: flex; align-items: center; gap: 8px; padding: 6px 0;
                         border-bottom: 1px solid var(--border); font-size: 11px; }
  .message-flow-item:last-child { border-bottom: none; }
  .msg-from { color: var(--text2); }
  .msg-arrow { color: var(--text3); }
  .msg-to { color: var(--accent); font-weight: 600; }
  .msg-type { background: var(--bg3); border: 1px solid var(--border); border-radius: 3px;
               padding: 1px 6px; color: var(--text3); font-size: 10px; }
  .msg-time { margin-left: auto; color: var(--text3); font-size: 10px; }

  /* Timeline */
  .agent-timeline { display: flex; flex-direction: column; gap: 8px; }
  .timeline-row { display: flex; align-items: center; gap: 10px; }
  .timeline-label { font-size: 10px; color: var(--text2); width: 130px; flex-shrink: 0;
                     white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
  .timeline-track { flex: 1; background: var(--bg3); border-radius: 3px; height: 12px; position: relative; overflow: hidden; }
  .timeline-bar { position: absolute; top: 0; height: 100%; border-radius: 3px;
                   background: linear-gradient(90deg, var(--purple), #a371f7); opacity: .8; }

  /* ── Chat ───────────────────────────────── */
  .chat-header { padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg2);
                 flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
  .chat-header-title { font-size: 12px; font-weight: 600; flex: 1;
                       white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text2); }
  .chat-body { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }

  .msg { display: flex; gap: 10px; max-width: 100%; }
  .msg.user { flex-direction: row-reverse; }
  .msg-avatar { width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0; display: flex;
                align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
                margin-top: 2px; }
  .msg.user .msg-avatar { background: var(--accent2); color: #fff; }
  .msg.assistant .msg-avatar { background: #cc785c; color: #fff; }
  .msg-content { flex: 1; min-width: 0; }
  .msg-meta { font-size: 10px; color: var(--text3); margin-bottom: 5px; }
  .msg.user .msg-meta { text-align: right; }
  .model-chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 999px;
                border: 1px solid transparent; font-weight: 600; }
  .model-chip-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  .bubble { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
            padding: 10px 14px; font-size: 13px; line-height: 1.6; }
  .msg.user .bubble { background: var(--accent2); border-color: transparent; color: #fff; }

  /* Text in bubble */
  .bubble p { margin: 0 0 8px 0; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble code { background: var(--bg3); border: 1px solid var(--border2); border-radius: 4px;
                 padding: 1px 5px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: .85em; }
  .msg.user .bubble code { background: rgba(0,0,0,.2); border-color: rgba(255,255,255,.2); }
  .bubble pre { background: var(--bg3); border: 1px solid var(--border2); border-radius: 6px;
                padding: 10px 12px; overflow-x: auto; margin: 8px 0; }
  .bubble pre code { background: none; border: none; padding: 0; font-size: .82em; }
  .bubble strong { color: var(--text); font-weight: 600; }
  .msg.user .bubble strong { color: inherit; }
  .bubble h1,.bubble h2,.bubble h3 { margin: 12px 0 6px; }
  .bubble ul,.bubble ol { padding-left: 18px; margin: 6px 0; }
  .bubble li { margin: 2px 0; }
  .bubble hr { border: 0; border-top: 1px solid var(--border2); margin: 12px 0; }
  .md-table-wrap { overflow-x: auto; margin: 10px 0; }
  .bubble table { width: 100%; border-collapse: collapse; min-width: 360px; font-size: 12px; }
  .bubble th,.bubble td { border: 1px solid var(--border2); padding: 6px 8px; vertical-align: top; }
  .bubble th { background: var(--bg3); color: var(--text); font-weight: 600; text-align: left; }
  .bubble td { color: inherit; }
  .msg.user .bubble th,.msg.user .bubble td { border-color: rgba(255,255,255,.24); }
  .msg.user .bubble th { background: rgba(0,0,0,.18); color: inherit; }
  .msg.user .bubble hr { border-top-color: rgba(255,255,255,.28); }

  /* Thinking block */
  .thinking-block { border: 1px solid var(--border); border-radius: 6px; margin: 6px 0; overflow: hidden; }
  .thinking-toggle { padding: 6px 10px; font-size: 11px; color: var(--text2); cursor: pointer;
                     background: var(--bg3); display: flex; align-items: center; gap: 5px;
                     user-select: none; }
  .thinking-toggle:hover { background: var(--bg4); }
  .thinking-body { padding: 8px 10px; font-size: 11px; color: var(--text2); line-height: 1.5;
                   white-space: pre-wrap; font-family: monospace; display: none; }
  .thinking-block.open .thinking-body { display: block; }

  /* Tool results row (user role だがユーザー入力ではない) */
  .tool-results-row { padding-left: 38px; display: flex; flex-direction: column; gap: 4px; }

  /* Tool call block */
  .tool-block { border: 1px solid var(--border); border-radius: 6px; margin: 6px 0; overflow: hidden; font-size: 12px; }
  .tool-header { padding: 6px 10px; background: var(--bg3); display: flex; align-items: center;
                 gap: 6px; cursor: pointer; user-select: none; }
  .tool-header:hover { background: var(--bg4); }
  .tool-name-badge { background: var(--bg4); border: 1px solid var(--border2); border-radius: 4px;
                     padding: 1px 6px; font-size: 11px; font-weight: 600; color: var(--orange);
                     font-family: 'SF Mono', monospace; }
  .tool-desc { font-size: 11px; color: var(--text2); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tool-toggle-icon { font-size: 10px; color: var(--text3); flex-shrink: 0; }
  .tool-body { padding: 8px 10px; display: none; }
  .tool-block.open .tool-body { display: block; }
  .tool-input-pre { background: var(--bg3); border: 1px solid var(--border2); border-radius: 4px;
                    padding: 6px 8px; font-family: 'SF Mono', monospace; font-size: 11px;
                    white-space: pre-wrap; word-break: break-all; color: var(--text2); }
  .tool-meta-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .tool-meta-pill { background: var(--bg3); border: 1px solid var(--border2); border-radius: 999px;
                    padding: 2px 8px; font-size: 10px; color: var(--text2); }
  .tool-meta-pill.file { max-width: 100%; font-family: 'SF Mono', monospace; }
  .tool-raw-details { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
  .tool-raw-details summary { cursor: pointer; color: var(--text2); font-size: 11px; user-select: none; }
  .tool-raw-details[open] summary { margin-bottom: 6px; }

  /* Diff view */
  .diff-stack { display: flex; flex-direction: column; gap: 8px; }
  .diff-card { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--bg2); }
  .diff-card-title { padding: 6px 10px; background: var(--bg3); border-bottom: 1px solid var(--border);
                     font-size: 11px; color: var(--text2); font-weight: 600; }
  .diff-file-meta { padding: 6px 10px; border-bottom: 1px solid var(--border); display: flex;
                    flex-wrap: wrap; gap: 8px; font-size: 10px; color: var(--text2); background: rgba(110,118,129,.06); }
  .diff-file-label { font-family: 'SF Mono', 'Fira Code', monospace; }
  .diff-file-label.old { color: var(--red); }
  .diff-file-label.new { color: var(--green); }
  .diff-table { width: 100%; border-collapse: collapse; table-layout: fixed;
                font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; }
  .diff-table td { padding: 0; vertical-align: top; }
  .diff-sign { width: 18px; text-align: center; color: var(--text3); border-right: 1px solid var(--border); user-select: none; }
  .diff-line-no { width: 44px; padding: 2px 8px 2px 6px; text-align: right; color: var(--text3);
                  border-right: 1px solid var(--border); background: rgba(110,118,129,.08); user-select: none; }
  .diff-code { padding: 2px 10px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  .diff-row.hunk td { background: rgba(88,166,255,.12); color: var(--accent); }
  .diff-row.hunk .diff-code { font-weight: 600; }
  .diff-row.context .diff-code { color: var(--text2); }
  .diff-row.add td { background: rgba(63,185,80,.10); }
  .diff-row.add .diff-sign { color: var(--green); }
  .diff-row.add .diff-line-no { background: rgba(63,185,80,.12); }
  .diff-row.remove td { background: rgba(248,81,73,.10); }
  .diff-row.remove .diff-sign { color: var(--red); }
  .diff-row.remove .diff-line-no { background: rgba(248,81,73,.12); }
  .diff-inline-add { background: rgba(63,185,80,.22); border-radius: 3px; }
  .diff-inline-remove { background: rgba(248,81,73,.22); border-radius: 3px; }
  .diff-empty { padding: 12px 14px; font-size: 11px; color: var(--text3); }

  /* Tool result block */
  .result-block { border: 1px solid var(--border); border-radius: 6px; margin: 6px 0; overflow: hidden; font-size: 12px; }
  .result-block.error { border-color: rgba(248,81,73,.4); }
  .result-header { padding: 5px 10px; background: var(--bg3); display: flex; align-items: center;
                   gap: 6px; cursor: pointer; user-select: none; }
  .result-header:hover { background: var(--bg4); }
  .result-label { font-size: 10px; font-weight: 600; color: var(--green); }
  .result-block.error .result-label { color: var(--red); }
  .result-preview { font-size: 10px; color: var(--text2); flex: 1; white-space: nowrap;
                    overflow: hidden; text-overflow: ellipsis; font-family: monospace; }
  .result-body { padding: 8px 10px; display: none; }
  .result-block.open .result-body { display: block; }
  .result-pre { background: var(--bg3); border: 1px solid var(--border2); border-radius: 4px;
                padding: 6px 8px; font-family: 'SF Mono', monospace; font-size: 11px;
                white-space: pre-wrap; word-break: break-all; color: var(--text2);
                max-height: 300px; overflow-y: auto; }

  /* Loading / error */
  .loading { display: flex; align-items: center; justify-content: center;
             padding: 40px; color: var(--text2); gap: 10px; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border);
             border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error-msg { background: rgba(248,81,73,.08); border: 1px solid rgba(248,81,73,.3);
               border-radius: var(--radius); padding: 10px 14px; color: var(--red);
               font-size: 12px; margin-bottom: 12px; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text2); }
</style>
</head>
<body>
<header>
  <h1>Claude Token Viewer</h1>
  <div class="header-right">
    <button class="btn" id="analyze-btn" disabled onclick="runProjectAnalysis()">一括分析</button>
  </div>
</header>

<div class="app">
  <!-- Sidebar: projects -->
  <div class="sidebar">
    <div class="pane-header">プロジェクト
      <button class="link-btn" id="toggle-empty-proj-btn" onclick="toggleShowEmptyProjects()" style="margin-left:auto;text-transform:none;font-weight:400">空を表示</button>
    </div>
    <div class="sidebar-list" id="project-list">
      <div class="loading"><div class="spinner"></div></div>
    </div>
  </div>

  <!-- Sessions panel -->
  <div class="sessions-panel">
    <div class="sessions-toolbar">
      <div class="sessions-toolbar-title" id="sessions-title">セッション</div>
      <button class="link-btn" id="toggle-empty-sess-btn" onclick="toggleShowEmptySessions()">空を表示</button>
    </div>
    <div class="sessions-list" id="sessions-list">
      <div style="padding:16px;font-size:12px;color:var(--text2)">プロジェクトを選択</div>
    </div>
  </div>

  <!-- Right panel: tabs -->
  <div class="right-panel">
    <div class="tab-bar">
      <div class="tab active" id="tab-chat" onclick="switchTab('chat')">チャット</div>
      <div class="tab" id="tab-analysis" onclick="switchTab('analysis')">分析</div>
    </div>
    <div class="panel-content" id="panel-chat">
      <div class="empty-state" id="chat-empty">
        <div class="icon">💬</div>
        <p>セッションをクリックしてチャット履歴を表示</p>
      </div>
      <div id="chat-view" style="display:none;flex:1;overflow:hidden;flex-direction:column;"></div>
    </div>
    <div class="panel-content" id="panel-analysis" style="display:none">
      <div class="panel-body" id="analysis-body">
        <div class="empty-state">
          <div class="icon">📊</div>
          <p>セッションを選択するとここに分析が表示されます</p>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
const TOOL_COLOR = {
  Read: '#58a6ff', Grep: '#58a6ff', Glob: '#58a6ff',
  Edit: '#3fb950', Write: '#3fb950', MultiEdit: '#3fb950',
  Bash: '#ffa657',
  Agent: '#bc8cff',
  WebSearch: '#39d353', WebFetch: '#39d353',
  Task: '#d29922', TaskCreate: '#d29922', TaskUpdate: '#d29922', TaskGet: '#d29922',
  Skill: '#79c0ff',
};

let state = {
  projects: [],
  activeProject: null,
  sessions: [],
  chatFile: null,           // currently loaded chat file path
  viewLevel: 'project',    // 'project' | 'session' — 分析タブの表示対象
  activeTab: 'chat',
  showEmptyProjects: false,
  showEmptySessions: false,
  // 分析キャッシュ: filePath or 'project:<id>' → { result, mtime, label }
  analysisCache: new Map(),
};

// ── Utilities ──────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')   // HTML エンティティ（先に処理）
    .replace(/\\/g, '\\\\')   // JS バックスラッシュ
    .replace(/\n/g, '\\n')    // JS 改行
    .replace(/\r/g, '')       // CR 除去
    .replace(/'/g, "\\'")     // JS シングルクォート
    .replace(/"/g, '&quot;'); // HTML ダブルクォート（属性の閉じを防ぐ）
}
function escTitleAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '')
    .replace(/\n/g, '&#10;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts), now = new Date(), diff = (now - d) / 1000;
    if (diff < 60) return `${Math.floor(diff)}秒前`;
    if (diff < 3600) return `${Math.floor(diff/60)}分前`;
    if (diff < 86400) return `${Math.floor(diff/3600)}時間前`;
    if (diff < 86400*7) return `${Math.floor(diff/86400)}日前`;
    return d.toLocaleDateString('ja-JP', {month:'short', day:'numeric'});
  } catch { return ts; }
}

function normalizeDiffText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function splitDiffLines(text) {
  const normalized = normalizeDiffText(text);
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function buildSimpleReplaceDiff(oldLines, newLines) {
  return [
    ...oldLines.map(text => ({type: 'remove', text})),
    ...newLines.map(text => ({type: 'add', text})),
  ];
}

function computeLineDiff(oldText, newText) {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length * newLines.length > 20000) {
    return buildSimpleReplaceDiff(oldLines, newLines);
  }

  const dp = Array.from({length: oldLines.length + 1}, () => Array(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({type: 'context', text: oldLines[i]});
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({type: 'remove', text: oldLines[i]});
      i += 1;
    } else {
      ops.push({type: 'add', text: newLines[j]});
      j += 1;
    }
  }
  while (i < oldLines.length) {
    ops.push({type: 'remove', text: oldLines[i]});
    i += 1;
  }
  while (j < newLines.length) {
    ops.push({type: 'add', text: newLines[j]});
    j += 1;
  }
  return ops;
}

function renderInlineDiffPair(oldLine, newLine) {
  const a = String(oldLine ?? '');
  const b = String(newLine ?? '');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const aMidEnd = a.length - suffix;
  const bMidEnd = b.length - suffix;
  const aHead = a.slice(0, prefix);
  const bHead = b.slice(0, prefix);
  const aMid = a.slice(prefix, aMidEnd);
  const bMid = b.slice(prefix, bMidEnd);
  const aTail = a.slice(aMidEnd);
  const bTail = b.slice(bMidEnd);

  const oldHtml = `${escHtml(aHead)}${aMid ? `<span class="diff-inline-remove">${escHtml(aMid)}</span>` : ''}${escHtml(aTail)}`;
  const newHtml = `${escHtml(bHead)}${bMid ? `<span class="diff-inline-add">${escHtml(bMid)}</span>` : ''}${escHtml(bTail)}`;
  return {oldHtml, newHtml};
}

function renderDiffRow(kind, oldNo, newNo, codeHtml) {
  const marker = kind === 'add' ? '+' : kind === 'remove' ? '-' : kind === 'hunk' ? '@' : ' ';
  return `
    <tr class="diff-row ${kind}">
      <td class="diff-sign">${marker}</td>
      <td class="diff-line-no">${oldNo || ''}</td>
      <td class="diff-line-no">${newNo || ''}</td>
      <td class="diff-code">${codeHtml || '&nbsp;'}</td>
    </tr>`;
}

function buildDiffHunks(oldText, newText, contextLines = 3) {
  const ops = computeLineDiff(oldText, newText);
  if (!ops.length) return [];

  let oldCursor = 1, newCursor = 1;
  const located = ops.map(op => {
    const item = {
      ...op,
      oldStart: oldCursor,
      newStart: newCursor,
      oldNo: op.type === 'add' ? null : oldCursor,
      newNo: op.type === 'remove' ? null : newCursor,
    };
    if (op.type !== 'add') oldCursor += 1;
    if (op.type !== 'remove') newCursor += 1;
    return item;
  });

  const changed = [];
  for (let i = 0; i < located.length; i += 1) {
    if (located[i].type !== 'context') changed.push(i);
  }
  if (!changed.length) return [];

  const hunks = [];
  let start = Math.max(0, changed[0] - contextLines);
  let end = Math.min(located.length - 1, changed[0] + contextLines);

  for (let idx = 1; idx < changed.length; idx += 1) {
    const nextStart = Math.max(0, changed[idx] - contextLines);
    const nextEnd = Math.min(located.length - 1, changed[idx] + contextLines);
    if (nextStart <= end + 1) {
      end = Math.max(end, nextEnd);
    } else {
      hunks.push(located.slice(start, end + 1));
      start = nextStart;
      end = nextEnd;
    }
  }
  hunks.push(located.slice(start, end + 1));
  return hunks;
}

function formatDiffRange(start, count) {
  if (count === 1) return String(start);
  return `${start},${count}`;
}

function renderDiffHunkRows(hunkOps) {
  let html = '';
  const oldCount = hunkOps.filter(op => op.type !== 'add').length;
  const newCount = hunkOps.filter(op => op.type !== 'remove').length;
  const header = `@@ -${formatDiffRange(hunkOps[0].oldStart, oldCount)} +${formatDiffRange(hunkOps[0].newStart, newCount)} @@`;
  html += renderDiffRow('hunk', '', '', escHtml(header));

  for (let i = 0; i < hunkOps.length;) {
    const op = hunkOps[i];
    if (op.type === 'context') {
      html += renderDiffRow('context', op.oldNo, op.newNo, escHtml(op.text));
      i += 1;
      continue;
    }

    const removed = [];
    const added = [];
    while (i < hunkOps.length && hunkOps[i].type !== 'context') {
      if (hunkOps[i].type === 'remove') removed.push(hunkOps[i]);
      if (hunkOps[i].type === 'add') added.push(hunkOps[i]);
      i += 1;
    }

    const maxLen = Math.max(removed.length, added.length);
    for (let idx = 0; idx < maxLen; idx += 1) {
      const removedLine = removed[idx];
      const addedLine = added[idx];
      if (removedLine && addedLine) {
        const inline = renderInlineDiffPair(removedLine.text, addedLine.text);
        html += renderDiffRow('remove', removedLine.oldNo, '', inline.oldHtml);
        html += renderDiffRow('add', '', addedLine.newNo, inline.newHtml);
      } else if (removedLine) {
        html += renderDiffRow('remove', removedLine.oldNo, '', escHtml(removedLine.text));
      } else if (addedLine) {
        html += renderDiffRow('add', '', addedLine.newNo, escHtml(addedLine.text));
      }
    }
  }

  return html;
}

function renderDiffTable(oldText, newText) {
  const hunks = buildDiffHunks(oldText, newText);
  if (!hunks.length) {
    return `<div class="diff-empty">変更なし</div>`;
  }

  let html = '<table class="diff-table"><tbody>';
  for (const hunk of hunks) {
    html += renderDiffHunkRows(hunk);
  }
  html += '</tbody></table>';
  return html;
}

function renderDiffCard(title, oldText, newText, path = '') {
  return `
    <div class="diff-card">
      <div class="diff-card-title">${escHtml(title)}</div>
      <div class="diff-file-meta">
        <span class="diff-file-label old">--- before</span>
        <span class="diff-file-label new">+++ after</span>
        ${path ? `<span>${escHtml(path)}</span>` : ''}
      </div>
      ${renderDiffTable(oldText, newText)}
    </div>`;
}

function renderToolMetaRow(input, extra = []) {
  const pills = [];
  if (input.file_path) {
    pills.push(`<span class="tool-meta-pill file" title="${escAttr(input.file_path)}">${escHtml(input.file_path)}</span>`);
  }
  if (input.replace_all) {
    pills.push('<span class="tool-meta-pill">replace_all</span>');
  }
  for (const item of extra) {
    if (item) pills.push(`<span class="tool-meta-pill">${escHtml(item)}</span>`);
  }
  return pills.length ? `<div class="tool-meta-row">${pills.join('')}</div>` : '';
}

function renderRawToolInput(inputStr) {
  return `
    <details class="tool-raw-details">
      <summary>Raw input を表示</summary>
      <pre class="tool-input-pre">${escHtml(inputStr)}</pre>
    </details>`;
}

function renderDiffToolBody(c, inputStr) {
  if (c.tool_name === 'Edit' &&
      typeof c.input.old_string === 'string' &&
      typeof c.input.new_string === 'string') {
    return `
      ${renderToolMetaRow(c.input)}
      ${renderDiffCard('差分', c.input.old_string, c.input.new_string, c.input.file_path || '')}
      ${renderRawToolInput(inputStr)}`;
  }

  if (c.tool_name === 'MultiEdit' && Array.isArray(c.input.edits) && c.input.edits.length > 0) {
    const cards = c.input.edits.map((edit, index) => {
      if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string') {
        return '';
      }
      const extra = edit.replace_all ? ['replace_all'] : [];
      return `
        <div>
          ${renderToolMetaRow({...c.input, replace_all: false, file_path: c.input.file_path || edit.file_path || ''}, [`編集 ${index + 1}`, ...extra])}
          ${renderDiffCard(`編集 ${index + 1}`, edit.old_string, edit.new_string, c.input.file_path || edit.file_path || '')}
        </div>`;
    }).filter(Boolean).join('');

    if (cards) {
      return `
        ${renderToolMetaRow(c.input, [`${c.input.edits.length} edits`])}
        <div class="diff-stack">${cards}</div>
        ${renderRawToolInput(inputStr)}`;
    }
  }

  return `<pre class="tool-input-pre">${escHtml(inputStr)}</pre>`;
}

function fmtTokens(n) {
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtCost(c) {
  if (c == null) return 'N/A';
  if (c < 0.001) return '$' + c.toFixed(6);
  return '$' + c.toFixed(4);
}

function inputActivityTokens(stats) {
  return (stats?.input_tokens || 0)
    + (stats?.cache_read_tokens || 0)
    + (stats?.cache_creation_5m || 0)
    + (stats?.cache_creation_1h || 0);
}

function tokenUsageTokens(stats) {
  return (stats?.latest_total_input_tokens || 0) + (stats?.latest_output_tokens || 0);
}

function getModelTheme(model) {
  const name = String(model || '').toLowerCase();
  if (name.includes('opus')) {
    return { dot: '#f78166', text: '#ffb4a3', bg: 'rgba(247,129,102,.14)', border: 'rgba(247,129,102,.38)' };
  }
  if (name.includes('sonnet')) {
    return { dot: '#79c0ff', text: '#a5d6ff', bg: 'rgba(121,192,255,.14)', border: 'rgba(121,192,255,.34)' };
  }
  if (name.includes('haiku')) {
    return { dot: '#56d364', text: '#8ae79a', bg: 'rgba(86,211,100,.14)', border: 'rgba(86,211,100,.34)' };
  }
  return { dot: '#bc8cff', text: '#d2b3ff', bg: 'rgba(188,140,255,.14)', border: 'rgba(188,140,255,.34)' };
}

function renderUsageTimeline(timeline, title = 'Token Usage per Request') {
  if (!timeline || !timeline.length) return '';
  const maxUsage = Math.max(...timeline.map(point => point.token_usage || 0), 1);
  const latest = timeline[timeline.length - 1];
  const barsHtml = timeline.map(point => {
    const totalHeight = Math.max((point.token_usage || 0) / maxUsage * 100, 2);
    const rawInputRatio = (point.token_usage || 0) > 0
      ? (point.input_tokens || 0) / point.token_usage
      : 0;
    const cacheReadRatio = (point.token_usage || 0) > 0
      ? (point.cache_read_tokens || 0) / point.token_usage
      : 0;
    const cacheWriteRatio = (point.token_usage || 0) > 0
      ? (point.cache_write_tokens || 0) / point.token_usage
      : 0;
    const outputRatio = (point.token_usage || 0) > 0
      ? (point.output_tokens || 0) / point.token_usage
      : 0;
    const rawInputHeight = totalHeight * rawInputRatio;
    const cacheReadHeight = totalHeight * cacheReadRatio;
    const cacheWriteHeight = totalHeight * cacheWriteRatio;
    const outputHeight = totalHeight * outputRatio;
    const types = (point.content_types || []).join(' + ') || 'unknown';
    const tip = [
      `Request ${point.request_index}`,
      `Types: ${types}`,
      point.user_summary ? `Prompt: ${point.user_summary}` : null,
      `Token Usage: ${fmtTokens(point.token_usage || 0)}`,
      `Total Input: ${fmtTokens(point.total_input_tokens || 0)}`,
      `Output: ${fmtTokens(point.output_tokens || 0)}`,
      `新規入力: ${fmtTokens(point.input_tokens || 0)}`,
      `Cacheヒット: ${fmtTokens(point.cache_read_tokens || 0)}`,
      `Cache書込: ${fmtTokens(point.cache_write_tokens || 0)}`,
    ].filter(Boolean).join('\n');
    return `
      <div class="usage-trend-col" title="${escTitleAttr(tip)}">
        <div class="usage-trend-bar-wrap">
          <div class="usage-trend-bar" style="height:${totalHeight.toFixed(1)}%">
            <div class="usage-trend-output" style="height:${outputHeight.toFixed(1)}%"></div>
            <div class="usage-trend-input-raw" style="height:${rawInputHeight.toFixed(1)}%"></div>
            <div class="usage-trend-cache-write" style="height:${cacheWriteHeight.toFixed(1)}%"></div>
            <div class="usage-trend-cache-read" style="height:${cacheReadHeight.toFixed(1)}%"></div>
          </div>
        </div>
        <div class="usage-trend-turn">${point.request_index}</div>
      </div>`;
  }).join('');

  return `
    <div class="usage-trend-card">
      <div class="usage-trend-header">
        <div class="usage-trend-title">${escHtml(title)}</div>
        <div class="usage-trend-meta">latest ${fmtTokens(latest.token_usage || 0)} / peak ${fmtTokens(maxUsage)}</div>
      </div>
      <div class="usage-trend-legend">
        <div class="usage-legend-item"><span class="usage-legend-swatch" style="background:#3fb950"></span><span>Cacheヒット</span></div>
        <div class="usage-legend-item"><span class="usage-legend-swatch" style="background:#d29922"></span><span>Cache書込</span></div>
        <div class="usage-legend-item"><span class="usage-legend-swatch" style="background:#58a6ff"></span><span>新規入力</span></div>
        <div class="usage-legend-item"><span class="usage-legend-swatch" style="background:#f85149"></span><span>Output</span></div>
      </div>
      <div class="usage-trend-scroll">
        <div class="usage-trend-bars">${barsHtml}</div>
      </div>
    </div>`;
}

// ── Markdown renderer (no deps) ─────────────────────────────

function flushList(state) {
  if (!state.listType) return '';
  const html = `</${state.listType}>`;
  state.listType = null;
  return html;
}

function isTableSeparator(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function isTableStart(lines, index) {
  const header = lines[index] || '';
  const separator = lines[index + 1] || '';
  return header.includes('|') && isTableSeparator(separator);
}

function isHorizontalRule(line) {
  return /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line);
}

function parseTableRow(line) {
  let normalized = line.trim();
  if (normalized.startsWith('|')) normalized = normalized.slice(1);
  if (normalized.endsWith('|')) normalized = normalized.slice(0, -1);
  return normalized.split('|').map(cell => cell.trim());
}

function parseTableAlignments(line) {
  return parseTableRow(line).map(cell => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function renderTable(lines, startIndex) {
  const headerCells = parseTableRow(lines[startIndex]);
  const alignments = parseTableAlignments(lines[startIndex + 1]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || !line.includes('|')) break;
    rows.push(parseTableRow(line));
    index += 1;
  }

  const headerHtml = headerCells.map((cell, i) => {
    const align = alignments[i] || 'left';
    return `<th style="text-align:${align}">${inlineFormat(cell)}</th>`;
  }).join('');

  const bodyHtml = rows.map(row => {
    const cols = headerCells.map((_, i) => {
      const align = alignments[i] || 'left';
      return `<td style="text-align:${align}">${inlineFormat(row[i] || '')}</td>`;
    }).join('');
    return `<tr>${cols}</tr>`;
  }).join('');

  return {
    html: `<div class="md-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: index,
  };
}

function renderMarkdown(text) {
  let lines = text.split('\n');
  let html = '';
  let inCode = false, codeLang = '', codeLines = [];
  const state = { listType: null };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!inCode && line.startsWith('```')) {
      html += flushList(state);
      inCode = true;
      codeLang = line.slice(3).trim();
      codeLines = [];
      i += 1;
      continue;
    }
    if (inCode) {
      if (line.startsWith('```')) {
        html += `<pre><code>${escHtml(codeLines.join('\n'))}</code></pre>`;
        inCode = false; codeLines = [];
      } else {
        codeLines.push(line);
      }
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      html += flushList(state);
      const table = renderTable(lines, i);
      html += table.html;
      i = table.nextIndex;
      continue;
    }
    if (isHorizontalRule(line)) {
      html += flushList(state);
      html += '<hr>';
      i += 1;
      continue;
    }
    // Headings
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      html += flushList(state);
      html += `<h${hm[1].length}>${inlineFormat(hm[2])}</h${hm[1].length}>`;
      i += 1;
      continue;
    }
    // List items
    const lm = line.match(/^[\s]*([-*]|\d+\.)\s+(.+)/);
    if (lm) {
      const nextListType = /^\d+\.$/.test(lm[1]) ? 'ol' : 'ul';
      if (state.listType !== nextListType) {
        html += flushList(state);
        state.listType = nextListType;
        html += `<${nextListType}>`;
      }
      html += `<li>${inlineFormat(lm[2])}</li>`;
      i += 1;
      continue;
    }
    // Blank line
    if (!line.trim()) {
      html += flushList(state);
      html += '<br>';
      i += 1;
      continue;
    }
    // Normal line
    html += flushList(state);
    html += `<p>${inlineFormat(line)}</p>`;
    i += 1;
  }
  if (inCode && codeLines.length) {
    html += `<pre><code>${escHtml(codeLines.join('\n'))}</code></pre>`;
  }
  html += flushList(state);
  return html;
}

function inlineFormat(text) {
  const codeTokens = [];
  text = text.replace(/`([^`]+)`/g, (_, c) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${escHtml(c)}</code>`);
    return token;
  });
  text = escHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  codeTokens.forEach((tokenHtml, index) => {
    text = text.replace(`\u0000CODE${index}\u0000`, tokenHtml);
  });
  return text;
}

// ── API ────────────────────────────────────────────────────

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── Init ───────────────────────────────────────────────────

async function init() {
  try {
    state.projects = await api('/api/projects');
    renderProjects();
    if (state.projects.length > 0) selectProject(state.projects[0].id);
  } catch(e) {
    document.getElementById('project-list').innerHTML =
      `<div class="error-msg" style="margin:10px">${escHtml(e.message)}</div>`;
  }
}

// ── Projects ───────────────────────────────────────────────

function getVisibleProjects() {
  return state.showEmptyProjects
    ? state.projects
    : state.projects.filter(p => p.session_count > 0);
}

function toggleShowEmptyProjects() {
  state.showEmptyProjects = !state.showEmptyProjects;
  const btn = document.getElementById('toggle-empty-proj-btn');
  if (btn) btn.textContent = state.showEmptyProjects ? '空を隠す' : '空を表示';
  renderProjects();
}

function renderProjects() {
  const visible = getVisibleProjects();
  const hidden = state.projects.length - visible.length;
  document.getElementById('project-list').innerHTML = visible.map(p => `
    <div class="project-item ${p.id===state.activeProject?'active':''}" onclick="selectProject('${p.id}')">
      <div class="project-name" title="${escAttr(p.display_name)}">${escHtml(p.display_name)}</div>
      <div class="project-count">${p.session_count} sessions</div>
    </div>`).join('')
    + (hidden > 0 && !state.showEmptyProjects
      ? `<div style="padding:6px 12px;font-size:10px;color:var(--text3)">${hidden} 件のセッションなしのプロジェクトを非表示</div>`
      : '');
}

async function selectProject(id) {
  state.activeProject = id;
  state.chatFile = null;
  state.viewLevel = 'project';
  state.analysisCache.clear();
  updateProjectBtn();
  updateTabBar();
  renderProjects();
  resetAnalysis();  // プロジェクト切り替え時に分析結果をリセット
  document.getElementById('sessions-list').innerHTML =
    '<div class="loading"><div class="spinner"></div></div>';
  try {
    state.sessions = await api(`/api/sessions?project=${encodeURIComponent(id)}`);
    const proj = state.projects.find(p => p.id === id);
    document.getElementById('sessions-title').textContent =
      `${proj?.display_name||id} (${state.sessions.length})`;
    renderSessions();
    updateProjectBtn();
  } catch(e) {
    document.getElementById('sessions-list').innerHTML =
      `<div class="error-msg" style="margin:10px">${escHtml(e.message)}</div>`;
  }
}

function updateProjectBtn() {
  document.getElementById('analyze-btn').disabled = !state.activeProject;
}

function resetAnalysis() {
  document.getElementById('analysis-body').innerHTML = `
    <div class="empty-state">
      <div class="icon">📊</div>
      <p>セッションを選択するとここに分析が表示されます</p>
    </div>`;
}

// ── Sessions list ──────────────────────────────────────────

function getVisibleSessions() {
  return state.showEmptySessions
    ? state.sessions
    : state.sessions.filter(s => s.first_message);
}

function toggleShowEmptySessions() {
  state.showEmptySessions = !state.showEmptySessions;
  const btn = document.getElementById('toggle-empty-sess-btn');
  if (btn) btn.textContent = state.showEmptySessions ? '空を隠す' : '空を表示';
  renderSessions();
}

function renderSessions() {
  const el = document.getElementById('sessions-list');
  if (!state.sessions.length) {
    el.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--text2)">セッションなし</div>';
    return;
  }
  const projOverviewActive = state.viewLevel === 'project';
  const projOverviewRow = `
    <div class="project-overview-row ${projOverviewActive ? 'active' : ''}" onclick="selectProjectOverview()">
      <span style="font-size:14px">📊</span>
      <span class="project-overview-label">プロジェクト全体</span>
    </div>`;
  const visible = getVisibleSessions();
  const hidden = state.sessions.length - visible.length;
  const hiddenNote = (hidden > 0 && !state.showEmptySessions)
    ? `<div style="padding:6px 10px;font-size:10px;color:var(--text3)">${hidden} 件のメッセージなしセッションを非表示</div>`
    : '';
  el.innerHTML = projOverviewRow + visible.map(s => {
    const chatActive = state.chatFile === s.jsonl_path;
    const label = s.first_message || s.session_id.slice(0,8)+'…';

    const subHtml = s.subagents.map(a => {
      const aChatActive = state.chatFile === a.jsonl_path;
      const displayLabel = a.description || a.agent_type;
      return `
        <div class="subagent-item ${aChatActive?'chat-active':''}">
          <div class="subagent-body" style="padding-left:24px" onclick="loadChat('${escAttr(a.jsonl_path)}','${escAttr(displayLabel)}')">
            <span class="subagent-icon">⚙</span>
            <span class="subagent-label" title="${escAttr(displayLabel)} · ${a.agent_id}">
              ${escHtml(displayLabel)}
            </span>
          </div>
        </div>`;
    }).join('');

    const teamHtml = (s.team_sessions || []).map(ts => {
      const tsChatActive = state.chatFile === ts.jsonl_path;
      const displayLabel = ts.description || ts.name || 'Team Agent';
      return `
        <div class="subagent-item ${tsChatActive?'chat-active':''}">
          <div class="subagent-body" style="padding-left:24px" onclick="loadChat('${escAttr(ts.jsonl_path)}','${escAttr(displayLabel)}')">
            <span class="subagent-icon" style="color:var(--accent)">👥</span>
            <span class="subagent-label" title="${escAttr(displayLabel)} · ${escAttr(ts.team_name)}">
              ${escHtml(displayLabel)}
            </span>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="session-item ${chatActive?'chat-active':''}">
        <div class="session-body" style="padding-left:10px" onclick="loadChat('${escAttr(s.jsonl_path)}','${escAttr(s.first_message||s.session_id)}')">
          <div class="session-msg" title="${escAttr(label)}">${escHtml(label)}</div>
          <div class="session-meta">
            <span>${fmtTime(s.timestamp)}</span>
            ${s.subagents.length ? `<span class="badge">⚙ ${s.subagents.length}</span>` : ''}
            ${(s.team_sessions||[]).length ? `<span class="badge" style="color:var(--accent)">👥 ${s.team_sessions.length}</span>` : ''}
          </div>
        </div>
      </div>
      ${subHtml}${teamHtml}`;
  }).join('') + hiddenNote;
}

function selectProjectOverview() {
  state.chatFile = null;
  state.viewLevel = 'project';
  renderSessions();
  updateTabBar();
  switchTab('analysis');
}

// ── Tabs ────────────────────────────────────────────────────

function updateTabBar() {
  const showChat = state.viewLevel === 'session';
  document.getElementById('tab-chat').style.display = showChat ? '' : 'none';
  // プロジェクト表示中にチャットタブが active になっていたら分析に切り替え
  if (!showChat && state.activeTab === 'chat') {
    switchTab('analysis');
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  document.getElementById('tab-chat').classList.toggle('active', tab==='chat');
  document.getElementById('tab-analysis').classList.toggle('active', tab==='analysis');
  document.getElementById('panel-chat').style.display = tab==='chat' ? 'flex' : 'none';
  document.getElementById('panel-analysis').style.display = tab==='analysis' ? 'flex' : 'none';

  // 分析タブに切り替えたとき：viewLevel に応じて自動表示（キャッシュ付き）
  if (tab === 'analysis') {
    if (state.viewLevel === 'session' && state.chatFile) {
      loadAnalysisWithCache(state.chatFile);
    } else if (state.activeProject) {
      loadProjectAnalysisWithCache();
    }
  }
}

// mtime を確認してキャッシュヒットなら再実行しない
async function loadAnalysisWithCache(filePath) {
  let currentMtime;
  try {
    const r = await api(`/api/mtime?file=${encodeURIComponent(filePath)}`);
    currentMtime = r.mtime;
  } catch(e) {
    // mtime 取得失敗時はキャッシュなしで実行
    runSingleSessionAnalysis(filePath, null);
    return;
  }

  const cached = state.analysisCache.get(filePath);
  if (cached && cached.mtime === currentMtime) {
    // キャッシュヒット — 再実行不要
    renderAnalysis(cached.result, cached.label);
    return;
  }

  runSingleSessionAnalysis(filePath, currentMtime);
}

// ── Chat ────────────────────────────────────────────────────

async function loadChat(path, label) {
  state.chatFile = path;
  state.viewLevel = 'session';
  renderSessions();
  updateTabBar();
  switchTab('analysis');

  document.getElementById('chat-empty').style.display = 'none';
  const chatView = document.getElementById('chat-view');
  chatView.style.display = 'flex';
  chatView.innerHTML = `
    <div class="chat-header">
      <div class="chat-header-title">${escHtml(label||path)}</div>
    </div>
    <div class="chat-body"><div class="loading"><div class="spinner"></div>読み込み中…</div></div>`;

  try {
    const messages = await api(`/api/chat?file=${encodeURIComponent(path)}`);
    renderChat(chatView, messages, label||path);
  } catch(e) {
    chatView.querySelector('.chat-body').innerHTML =
      `<div class="error-msg">${escHtml(e.message)}</div>`;
  }
}

function renderChat(chatView, messages, label) {
  const header = `
    <div class="chat-header">
      <div class="chat-header-title">${escHtml(label)}</div>
      <span style="font-size:10px;color:var(--text2)">${messages.length} ターン</span>
    </div>`;

  const bodyItems = messages.map(msg => renderMessage(msg)).join('');
  chatView.innerHTML = header + `<div class="chat-body">${bodyItems || '<div style="padding:20px;color:var(--text2);font-size:12px">メッセージなし</div>'}</div>`;
}

function renderMessage(msg) {
  const isUser = msg.role === 'user';

  if (isUser) {
    // ユーザーメッセージは text と tool_result を分けて描画する。
    // tool_result は API 仕様上 user ロールで届くが、
    // 実態はツールの実行結果なのでユーザー発言とは別スタイルにする。
    const textItems   = msg.content.filter(c => c.type === 'text');
    const resultItems = msg.content.filter(c => c.type === 'tool_result');
    let html = '';

    if (textItems.length > 0) {
      const contentHtml = textItems.map(c => renderContentItem(c, true)).join('');
      html += `
        <div class="msg user">
          <div class="msg-avatar">U</div>
          <div class="msg-content">${contentHtml}</div>
        </div>`;
    }

    if (resultItems.length > 0) {
      // ツール結果はアシスタント発言の直後に続く中立ブロックとして表示
      const resultHtml = resultItems.map(c => renderContentItem(c, false)).join('');
      html += `<div class="tool-results-row">${resultHtml}</div>`;
    }

    return html;
  }

  // アシスタントメッセージ
  const modelTheme = msg.model ? getModelTheme(msg.model) : null;
  const metaStr = [
    msg.model
      ? `<span class="model-chip" style="color:${modelTheme.text};background:${modelTheme.bg};border-color:${modelTheme.border}">
          <span class="model-chip-dot" style="background:${modelTheme.dot}"></span>
          <span>${escHtml(msg.model)}</span>
        </span>`
      : '',
    msg.timestamp ? fmtTime(msg.timestamp) : '',
  ].filter(Boolean).join(' · ');

  const contentHtml = msg.content.map(c => renderContentItem(c, false)).join('');

  return `
    <div class="msg assistant">
      <div class="msg-avatar">C</div>
      <div class="msg-content">
        ${metaStr ? `<div class="msg-meta">${metaStr}</div>` : ''}
        ${contentHtml}
      </div>
    </div>`;
}

function renderContentItem(c, isUser) {
  if (c.type === 'text') {
    return `<div class="bubble">${renderMarkdown(c.text)}</div>`;
  }
  if (c.type === 'thinking') {
    const id = 'th-' + Math.random().toString(36).slice(2);
    return `
      <div class="thinking-block" id="${id}">
        <div class="thinking-toggle" onclick="toggleBlock('${id}')">
          <span>🧠</span><span>思考</span><span style="margin-left:auto;font-size:9px">▼</span>
        </div>
        <div class="thinking-body">${escHtml(c.text)}</div>
      </div>`;
  }
  if (c.type === 'tool_use') {
    const id = 'tu-' + Math.random().toString(36).slice(2);
    const inputStr = JSON.stringify(c.input, null, 2);
    // Summary line from input
    let badge, desc;
    if (c.tool_name === 'Skill') {
      const skillName = c.input.skill || '';
      badge = skillName ? `SKILL(${skillName})` : 'Skill';
      desc = c.input.args || '';
    } else if (c.tool_name === 'Agent') {
      const agentType = c.input.subagent_type || '';
      badge = agentType ? `Agent(${agentType})` : 'Agent';
      desc = c.input.description || '';
    } else {
      badge = c.tool_name;
      desc = c.input.description || c.input.command || c.input.file_path || c.input.url || '';
    }
    const toolBody = renderDiffToolBody(c, inputStr);
    return `
      <div class="tool-block" id="${id}">
        <div class="tool-header" onclick="toggleBlock('${id}')">
          <span class="tool-name-badge">${escHtml(badge)}</span>
          <span class="tool-desc">${escHtml(desc)}</span>
          <span class="tool-toggle-icon">▼</span>
        </div>
        <div class="tool-body">
          ${toolBody}
        </div>
      </div>`;
  }
  if (c.type === 'tool_result') {
    const id = 'tr-' + Math.random().toString(36).slice(2);
    const preview = c.content.replace(/\n/g,' ').slice(0, 80);
    const isErr = c.is_error;
    return `
      <div class="result-block ${isErr?'error':''}" id="${id}">
        <div class="result-header" onclick="toggleBlock('${id}')">
          <span class="result-label">${isErr?'エラー':'結果'}</span>
          <span class="result-preview">${escHtml(preview)}</span>
          <span style="font-size:9px;color:var(--text3);flex-shrink:0">▼</span>
        </div>
        <div class="result-body">
          <pre class="result-pre">${escHtml(c.content)}</pre>
        </div>
      </div>`;
  }
  return '';
}

function toggleBlock(id) {
  document.getElementById(id).classList.toggle('open');
}

// ── Analysis ────────────────────────────────────────────────

function renderSubBreakdown(subcmds, maxRef, color) {
  if (!subcmds) return '';
  const sorted = Object.entries(subcmds).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!sorted.length) return '';
  const maxCount = maxRef || sorted[0][1] || 1;
  const rows = sorted.map(([name, count]) => `
    <div class="tool-stat-row" style="padding-left:16px">
      <div class="tool-stat-name" style="width:94px;color:var(--text3)" title="${escHtml(name)}">↳ ${escHtml(name)}</div>
      <div class="token-bar-wrap"><div class="token-bar" style="width:${(count/maxCount*100).toFixed(1)}%;background:${color}"></div></div>
      <div class="tool-stat-count" style="color:var(--text2)">${count}</div>
    </div>`).join('');
  return `<div style="margin-bottom:6px">${rows}</div>`;
}

function renderToolBars(counts, ts, maxCount) {
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = maxCount || sorted[0]?.[1] || 1;
  return sorted.map(([name, count]) => {
    const color = TOOL_COLOR[name] || '#6e7681';
    let sub = '';
    if (name === 'Bash')  sub = renderSubBreakdown(ts?.bash_commands,  max, '#c9890a');
    if (name === 'Skill') sub = renderSubBreakdown(ts?.skill_calls,     max, '#79c0ff');
    if (name === 'Agent') sub = renderSubBreakdown(ts?.agent_calls,     max, '#a371f7');
    return `
      <div class="tool-stat-row">
        <div class="tool-stat-name" title="${escHtml(name)}">${escHtml(name)}</div>
        <div class="token-bar-wrap"><div class="token-bar" style="width:${(count/max*100).toFixed(1)}%;background:${color}"></div></div>
        <div class="tool-stat-count">${count}</div>
      </div>
      ${sub}`;
  }).join('');
}

function renderToolStatsCard(ts) {
  if (!ts) return '';
  const counts = ts.tool_counts || {};
  const totalCalls = Object.values(counts).reduce((s, v) => s + v, 0);
  if (totalCalls === 0) return '';

  const errRate = ts.tool_results_total > 0
    ? (ts.tool_errors / ts.tool_results_total * 100) : 0;

  const maxCount = Math.max(...Object.values(counts), 1);
  const barsHtml = renderToolBars(counts, ts, maxCount);

  // インサイト生成
  const insights = [];
  const bashCount = counts['Bash'] || 0;
  const searchCount = (counts['Read']||0) + (counts['Grep']||0) + (counts['Glob']||0);
  if (bashCount > searchCount && bashCount > 10) {
    insights.push(`<div class="tool-insight warn">Bash (${bashCount}) が Read/Grep/Glob (${searchCount}) より多く使われています — 専用ツールへの置き換え余地があります</div>`);
  }
  if (ts.tool_results_total > 5) {
    if (errRate > 15) {
      insights.push(`<div class="tool-insight warn">エラー率 ${errRate.toFixed(1)}% — ツール呼び出しの失敗が多めです。指示の具体化やファイルの事前確認が効果的かもしれません</div>`);
    } else if (errRate <= 5) {
      insights.push(`<div class="tool-insight ok">エラー率 ${errRate.toFixed(1)}% — ツール呼び出しは安定しています</div>`);
    }
  }
  const editCount = (counts['Edit']||0) + (counts['Write']||0) + (counts['MultiEdit']||0);
  if (editCount > 0 && totalCalls > 0) {
    const editRatio = (editCount / totalCalls * 100).toFixed(0);
    insights.push(`<div class="tool-insight ok">Edit/Write は全呼び出しの ${editRatio}% (${editCount} 回) — コードを実際に書いた量の目安です</div>`);
  }

  return `
    <div class="summary-card" style="margin-bottom:16px">
      <div class="summary-title">ツール使用</div>
      <div class="summary-grid" style="margin-bottom:14px">
        <div class="summary-stat">
          <div class="summary-stat-label">総呼び出し</div>
          <div class="summary-stat-value">${totalCalls}</div>
        </div>
        <div class="summary-stat">
          <div class="summary-stat-label">エラー率</div>
          <div class="summary-stat-value ${errRate > 15 ? 'orange' : 'green'}">${errRate.toFixed(1)}%</div>
        </div>
        <div class="summary-stat">
          <div class="summary-stat-label">エラー数</div>
          <div class="summary-stat-value">${ts.tool_errors}</div>
        </div>
        <div class="summary-stat">
          <div class="summary-stat-label">Edit/Write</div>
          <div class="summary-stat-value green">${editCount}</div>
        </div>
      </div>
      ${barsHtml}
      ${insights.join('')}
    </div>`;
}

function renderSessionToolSection(ts) {
  if (!ts) return '';
  const counts = ts.tool_counts || {};
  const totalCalls = Object.values(counts).reduce((s, v) => s + v, 0);
  if (totalCalls === 0) return '';

  const errRate = ts.tool_results_total > 0
    ? (ts.tool_errors / ts.tool_results_total * 100) : 0;

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxCount = Math.max(...Object.values(counts), 1);

  const barsHtml = sorted.map(([name, count]) => {
    const color = TOOL_COLOR[name] || '#6e7681';
    let bashBreak = '';
    if (name === 'Bash')  bashBreak = renderSubBreakdown(ts?.bash_commands,  maxCount, '#c9890a');
    if (name === 'Skill') bashBreak = renderSubBreakdown(ts?.skill_calls,     maxCount, '#79c0ff');
    if (name === 'Agent') bashBreak = renderSubBreakdown(ts?.agent_calls,     maxCount, '#a371f7');
    return `
      <div class="tool-stat-row">
        <div class="tool-stat-name" title="${escHtml(name)}">${escHtml(name)}</div>
        <div class="token-bar-wrap"><div class="token-bar" style="width:${(count/maxCount*100).toFixed(1)}%;background:${color}"></div></div>
        <div class="tool-stat-count">${count}</div>
      </div>
      ${bashBreak}`;
  }).join('');

  const errBadge = ts.tool_results_total > 3
    ? `<span class="session-tool-err-badge ${ts.tool_errors > 0 ? 'has-error' : 'no-error'}">${ts.tool_errors > 0 ? '⚠ ' + ts.tool_errors + ' err' : '✓'}</span>`
    : '';

  return `
    <div class="session-tool-section">
      <div class="session-tool-title">
        <span>ツール (${totalCalls})</span>
        ${errBadge}
      </div>
      <div>${barsHtml}</div>
    </div>`;
}

// 指定ファイルのセッションを単体分析し、mtime とともにキャッシュする
async function runSingleSessionAnalysis(filePath, mtime) {
  // filePath に対応するセッションを探す
  let session = state.sessions.find(s => s.jsonl_path === filePath);
  let sessionsPayload;

  if (session) {
    // メインセッション
    sessionsPayload = [{
      session_id: session.session_id,
      label: session.first_message || session.session_id.slice(0, 8),
      session_file: session.jsonl_path,
      subagents: session.subagents.map(a => ({
        agent_id: a.agent_id,
        agent_type: a.agent_type,
        file: a.jsonl_path,
      })),
    }];
  } else {
    // サブエージェント or チームセッションか確認
    let subagent = null;
    let teamSess = null;
    for (const s of state.sessions) {
      const foundSub = s.subagents.find(a => a.jsonl_path === filePath);
      if (foundSub) { subagent = foundSub; break; }
      const foundTs = (s.team_sessions || []).find(ts => ts.jsonl_path === filePath);
      if (foundTs) { teamSess = foundTs; break; }
    }
    if (subagent) {
      sessionsPayload = [{
        session_id: subagent.agent_id,
        label: subagent.description || subagent.agent_type,
        session_file: subagent.jsonl_path,
        subagents: [],
      }];
    } else if (teamSess) {
      sessionsPayload = [{
        session_id: teamSess.session_id,
        label: teamSess.description || teamSess.name,
        session_file: teamSess.jsonl_path,
        subagents: [],
      }];
    } else {
      return;
    }
  }

  const label = sessionsPayload[0].label;

  document.getElementById('analysis-body').innerHTML =
    '<div class="loading"><div class="spinner"></div>分析中…</div>';

  try {
    const data = await api('/api/analyze', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessions: sessionsPayload}),
    });
    // mtime が取得できていればキャッシュに保存
    if (mtime != null) {
      state.analysisCache.set(filePath, { result: data, mtime, label });
    }
    renderAnalysis(data, label);
  } catch(e) {
    document.getElementById('analysis-body').innerHTML =
      `<div class="error-msg">${escHtml(e.message)}</div>`;
  }
}

// mtime を確認してキャッシュヒットならプロジェクト分析を再実行しない
async function loadProjectAnalysisWithCache() {
  if (!state.activeProject) return;
  const cacheKey = `project:${state.activeProject}`;

  let currentMtime;
  try {
    const r = await api(`/api/project_mtime?project=${encodeURIComponent(state.activeProject)}`);
    currentMtime = r.mtime;
  } catch(e) {
    // mtime 取得失敗 → キャッシュなしで実行
    await _execProjectAnalysis(null);
    return;
  }

  const cached = state.analysisCache.get(cacheKey);
  if (cached && cached.mtime === currentMtime) {
    renderAnalysis(cached.result, cached.label);
    return;
  }

  await _execProjectAnalysis(currentMtime);
}

// 選択中のプロジェクト全セッションを一括分析する（ボタン押下時）
async function runProjectAnalysis() {
  if (!state.activeProject || !state.sessions.length) return;
  // viewLevel を project に戻し、キャッシュを破棄して強制再実行
  state.viewLevel = 'project';
  state.analysisCache.delete(`project:${state.activeProject}`);
  switchTab('analysis');  // ← viewLevel='project' なので loadProjectAnalysisWithCache() が呼ばれる
}

// プロジェクト分析の実体（結果をキャッシュに保存する）
async function _execProjectAnalysis(mtime) {
  const proj = state.projects.find(p => p.id === state.activeProject);
  const projName = proj?.display_name || state.activeProject || '';

  const sessionsPayload = state.sessions.map(s => ({
    session_id: s.session_id,
    label: s.first_message || s.session_id.slice(0, 8),
    session_file: s.jsonl_path,
    subagents: s.subagents.map(a => ({
      agent_id: a.agent_id,
      agent_type: a.agent_type,
      file: a.jsonl_path,
    })),
  }));

  document.getElementById('analysis-body').innerHTML =
    '<div class="loading"><div class="spinner"></div>分析中…</div>';

  try {
    const data = await api('/api/analyze', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessions: sessionsPayload}),
    });
    if (mtime != null) {
      state.analysisCache.set(`project:${state.activeProject}`, { result: data, mtime, label: projName });
    }
    renderAnalysis(data, projName);
  } catch(e) {
    document.getElementById('analysis-body').innerHTML =
      `<div class="error-msg">${escHtml(e.message)}</div>`;
  }
}

// ── 全モデルの最大値を計算（バー正規化用）──────────────────

function calcMaxes(sessions) {
  let maxOut = 1, maxInputActivity = 1;
  for (const s of sessions) {
    for (const src of [s.combined, ...(s.subagents || [])]) {
      if (!src) continue;
      for (const [, st] of Object.entries(src.by_model || {})) {
        const output = st.output_tokens || 0;
        maxOut = Math.max(maxOut, output);
        maxInputActivity = Math.max(maxInputActivity, inputActivityTokens(st));
      }
    }
  }
  return {maxOut, maxInputActivity};
}

function renderAnalysis(data, projName) {
  const { sessions, grand_total: gt, grand_tool_stats: gts } = data;
  const gtCacheWrite = (gt.cache_creation_5m || 0) + (gt.cache_creation_1h || 0);
  const gtTokenUsage = tokenUsageTokens(gt);
  const tokenUsageHtml = (sessions.length === 1 && gtTokenUsage)
    ? `
        <div class="summary-stat"><div class="summary-stat-label">Token Usage</div>
          <div class="summary-stat-value primary">${fmtTokens(gtTokenUsage)}</div></div>`
    : '';

  const maxes = calcMaxes(sessions);

  const sessionCardsHtml = sessions.map(s => renderSessionCard(s, maxes)).join('');

  const html = `
    <div class="analysis-header">
      <div class="analysis-title">${escHtml(projName)} — ${sessions.length} セッション</div>
    </div>
    <div class="summary-card" style="margin-bottom:16px">
      <div class="summary-title">合計</div>
      <div class="summary-grid">
        ${tokenUsageHtml}
        ${gt.cost_usd != null ? `
        <div class="summary-stat"><div class="summary-stat-label">推定コスト</div>
          <div class="summary-stat-value orange">${fmtCost(gt.cost_usd)}</div></div>` : ''}
        <div class="summary-stat"><div class="summary-stat-label">リクエスト</div>
          <div class="summary-stat-value">${gt.requests}</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Total Output</div>
          <div class="summary-stat-value">${fmtTokens(gt.output_tokens)}</div></div>
        <div class="summary-stat"><div class="summary-stat-label">新規入力</div>
          <div class="summary-stat-value">${fmtTokens(gt.input_tokens)}</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Cacheヒット</div>
          <div class="summary-stat-value green">${fmtTokens(gt.cache_read_tokens)}</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Cache書込</div>
          <div class="summary-stat-value">${fmtTokens(gtCacheWrite)}</div></div>
        <div class="summary-stat"><div class="summary-stat-label">ヒット率</div>
          <div class="summary-stat-value green">${gt.cache_hit_rate.toFixed(1)}%</div></div>
      </div>
      <div class="summary-note">Token Usage = 最新リクエスト 1 件の総入力 + 総出力。Total Output と Cache 系はセッション累計です。</div>
    </div>
    ${renderToolStatsCard(gts)}
    <div class="session-cards">${sessionCardsHtml}</div>`;

  document.getElementById('analysis-body').innerHTML = html;
}

function renderSessionCard(s, maxes) {
  const ct = s.combined?.total || {};
  const ts = s.tool_stats;
  const usage = tokenUsageTokens(ct);

  // セッション本体モデル行
  const sessionModelHtml = s.session
    ? renderModelRows(s.session.by_model, maxes, true)
    : '';

  // サブエージェントセクション
  let subHtml = '';
  if (s.subagents && s.subagents.length) {
    const subCards = s.subagents.map(a => `
      <div class="subagent-card">
        <div class="subagent-card-header">
          <span class="subagent-type-badge">⚙ ${escHtml(a.agent_type)}</span>
          <span class="subagent-cost">${fmtCost(a.total?.cost_usd)}</span>
        </div>
        ${renderUsageTimeline(a.usage_timeline)}
        ${renderModelRows(a.by_model, maxes, false)}
      </div>`).join('');

    subHtml = `
      <div class="subagent-section">
        <div class="subagent-title">
          <span>サブエージェント (${s.subagents.length})</span>
        </div>
        <div class="subagent-list">${subCards}</div>
      </div>`;
  }

  const tsErrBadge = (ts && ts.tool_results_total > 3)
    ? `<span class="session-tool-err-badge ${ts.tool_errors > 0 ? 'has-error' : 'no-error'}">${ts.tool_errors > 0 ? '⚠ ' + ts.tool_errors + ' err' : '✓'}</span>`
    : '';

  return `
    <div class="session-card">
      <div class="session-card-header">
        <div class="session-card-label" title="${escAttr(s.label)}">${escHtml(s.label)}</div>
        ${usage ? `<div class="session-card-usage">TU ${fmtTokens(usage)}</div>` : ''}
        ${ct.cost_usd != null ? `<div class="session-card-cost">${fmtCost(ct.cost_usd)}</div>` : ''}
        <div class="session-card-reqs">${ct.requests || 0} req</div>
        ${tsErrBadge}
      </div>
      <div class="session-card-body">
        ${renderUsageTimeline(s.usage_timeline)}
        ${sessionModelHtml}
        ${subHtml}
        ${renderSessionToolSection(ts)}
      </div>
    </div>`;
}

function renderModelRows(byModel, _maxes, showSection) {
  const models = Object.keys(byModel || {});
  if (!models.length) return '';

  const rows = models.map((model, i) => {
    const s = byModel[model];
    const theme = getModelTheme(model);
    const usage = tokenUsageTokens(s);
    const uncachedInput = s.input_tokens || 0;
    const output = s.output_tokens || 0;
    const cacheWrite = (s.cache_creation_5m || 0) + (s.cache_creation_1h || 0);
    const cacheRead = s.cache_read_tokens || 0;
    return `
      <div class="model-card">
        <div class="model-card-header">
          <div class="model-dot" style="background:${theme.dot}"></div>
          <div class="model-name-sm" title="${model}" style="color:${theme.text}">${model}</div>
          <div class="model-card-meta">${usage ? `TU ${fmtTokens(usage)} · ` : ''}${s.requests} req</div>
        </div>
        <div class="model-metrics">
          <div class="model-metric">
            <div class="model-metric-label">Token Usage</div>
            <div class="model-metric-value primary">${fmtTokens(usage)}</div>
          </div>
          <div class="model-metric">
            <div class="model-metric-label">推定コスト</div>
            <div class="model-metric-value orange">${fmtCost(s.cost_usd)}</div>
          </div>
          <div class="model-metric">
            <div class="model-metric-label">リクエスト</div>
            <div class="model-metric-value">${s.requests}</div>
          </div>
          <div class="model-metric">
            <div class="model-metric-label">新規入力</div>
            <div class="model-metric-value">${fmtTokens(uncachedInput)}</div>
          </div>
          <div class="model-metric">
            <div class="model-metric-label">Total Output</div>
            <div class="model-metric-value">${fmtTokens(output)}</div>
          </div>
          <div class="model-metric">
            <div class="model-metric-label">Cacheヒット</div>
            <div class="model-metric-value green">${fmtTokens(cacheRead)}</div>
          </div>
          <div class="model-metric">
            <div class="model-metric-label">Cache書込</div>
            <div class="model-metric-value">${fmtTokens(cacheWrite)}</div>
          </div>
          <div class="model-metric">
            <div class="model-metric-label">ヒット率</div>
            <div class="model-metric-value green">${(s.cache_hit_rate||0).toFixed(0)}%</div>
          </div>
        </div>
      </div>`;
  }).join('');

  return showSection
    ? `<div class="model-section"><div class="model-section-label">セッション本体</div>${rows}</div>`
    : rows;
}

function pct(v, max) { return Math.min((v || 0) / (max || 1) * 100, 100); }

// ── Agent Graph ──────────────────────────────────────────────

async function loadAgentGraph(sessionFile) {
  const el = document.getElementById('graph-body');
  el.innerHTML = '<div class="loading"><div class="spinner"></div>読み込み中…</div>';
  try {
    const data = await api(`/api/agent_graph?file=${encodeURIComponent(sessionFile)}`);
    renderAgentGraph(data, sessionFile);
  } catch(e) {
    el.innerHTML = `<div class="error-msg">${escHtml(e.message)}</div>`;
  }
}

function renderAgentGraph(data, sessionFile) {
  const { agents, teams, messages } = data;
  const el = document.getElementById('graph-body');

  if (!agents.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="icon">🤖</div>
        <p>このセッションにはエージェントがいません</p>
      </div>`;
    return;
  }

  const session = state.sessions.find(s => s.jsonl_path === sessionFile);
  const sessionLabel = session?.first_message || (sessionFile.split('/').pop() || '').replace('.jsonl','');

  // エージェントノード HTML 生成
  function makeAgentNode(agent) {
    const hasChat = !!agent.jsonl_path;
    const isCurrentChat = hasChat && state.chatFile === agent.jsonl_path;
    const completion = agent.completion;
    const status = completion ? completion.status : (agent.run_in_background ? '非同期' : '同期');
    const statusColor = completion?.status === 'completed' ? 'var(--green)' : 'var(--orange)';
    const label = agent.description || agent.name || 'Agent';
    const clickFn = hasChat
      ? `loadChat('${escAttr(agent.jsonl_path)}','${escAttr(label)}')`
      : '';

    return `
      <div class="agent-node ${isCurrentChat ? 'current' : ''} ${hasChat ? 'clickable' : ''}"
           ${clickFn ? `onclick="${clickFn}"` : ''}>
        <div class="agent-node-icon">🤖</div>
        <div class="agent-node-body">
          <div class="agent-node-name">${escHtml(label)}</div>
          ${agent.name ? `<div class="agent-node-id">${escHtml(agent.name)}${agent.team_name ? ' @ ' + agent.team_name : ''}</div>` : ''}
          <div class="agent-node-status" style="color:${statusColor}">● ${escHtml(status)}</div>
        </div>
        ${hasChat ? '<div class="agent-node-link">→</div>' : ''}
      </div>`;
  }

  // チーム別・スタンドアロン別に分類
  const standaloneAgents = agents.filter(a => !a.team_name);
  const teamAgentsMap = {};
  for (const a of agents.filter(a => a.team_name)) {
    if (!teamAgentsMap[a.team_name]) teamAgentsMap[a.team_name] = [];
    teamAgentsMap[a.team_name].push(a);
  }

  // ツリー HTML
  let childrenHtml = '';
  for (const agent of standaloneAgents) {
    childrenHtml += `<div class="tree-child">${makeAgentNode(agent)}</div>`;
  }
  for (const [teamName, members] of Object.entries(teamAgentsMap)) {
    childrenHtml += `
      <div class="tree-child">
        <div class="team-group">
          <div class="team-group-header">
            <span class="team-icon">👥</span>
            <span class="team-name">${escHtml(teamName)}</span>
          </div>
          <div class="team-members">
            ${members.map(a => makeAgentNode(a)).join('')}
          </div>
        </div>
      </div>`;
  }

  const treeHtml = `
    <div class="graph-section">
      <div class="graph-section-title">エージェントツリー</div>
      <div class="graph-tree">
        <div class="orchestrator-node">
          <div class="agent-node-icon">👤</div>
          <div class="agent-node-body">
            <div class="agent-node-name">${escHtml(sessionLabel.slice(0, 50))}</div>
            <div class="agent-node-id">オーケストレーター</div>
          </div>
        </div>
        <div class="tree-connector"></div>
        <div class="tree-children">${childrenHtml}</div>
      </div>
    </div>`;

  // メッセージフロー HTML（shutdown 以外）
  const realMsgs = messages.filter(m => m.message_type !== 'shutdown_request');
  const messageHtml = realMsgs.length ? `
    <div class="graph-section">
      <div class="graph-section-title">メッセージフロー (${realMsgs.length})</div>
      ${realMsgs.map(m => `
        <div class="message-flow-item">
          <span class="msg-from">orchestrator</span>
          <span class="msg-arrow">→</span>
          <span class="msg-to">${escHtml(m.to)}</span>
          ${m.message_type ? `<span class="msg-type">${escHtml(m.message_type)}</span>` : ''}
          <span class="msg-time">${fmtTime(m.timestamp)}</span>
        </div>`).join('')}
    </div>` : '';

  // タイムライン HTML
  let timelineHtml = '';
  const agentsWithTs = agents.filter(a => a.timestamp);
  if (agentsWithTs.length > 0) {
    const startMs = agentsWithTs.map(a => new Date(a.timestamp).getTime());
    const endMs = agentsWithTs
      .filter(a => a.completion?.timestamp)
      .map(a => new Date(a.completion.timestamp).getTime());
    const minTs = Math.min(...startMs);
    const maxTs = endMs.length > 0 ? Math.max(...endMs, ...startMs) : Math.max(...startMs) + 1000;
    const range = maxTs - minTs || 1;

    const bars = agentsWithTs.map(a => {
      const start = new Date(a.timestamp).getTime();
      const end = a.completion?.timestamp ? new Date(a.completion.timestamp).getTime() : start + range * 0.15;
      const left = ((start - minTs) / range * 100).toFixed(1);
      const width = Math.max(((end - start) / range * 100), 2).toFixed(1);
      const label = (a.description || a.name || 'Agent').slice(0, 18);
      return `
        <div class="timeline-row">
          <div class="timeline-label">${escHtml(label)}</div>
          <div class="timeline-track">
            <div class="timeline-bar" style="left:${left}%;width:${width}%"></div>
          </div>
        </div>`;
    }).join('');

    timelineHtml = `
      <div class="graph-section">
        <div class="graph-section-title">タイムライン</div>
        <div class="agent-timeline">${bars}</div>
      </div>`;
  }

  el.innerHTML = treeHtml + messageHtml + timelineHtml;
}

init();
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def _safe_path(self, path: str) -> Optional[str]:
        real = os.path.realpath(path)
        real_projects = os.path.realpath(PROJECTS_DIR)
        if real.startswith(real_projects) and real.endswith(".jsonl"):
            return real
        return None

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            body = HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)

        elif path == "/api/projects":
            self.send_json(get_projects())

        elif path == "/api/sessions":
            pid = qs.get("project", [None])[0]
            if not pid or ".." in pid or "/" in pid:
                self.send_json({"error": "invalid project"}, 400)
                return
            self.send_json(get_sessions(pid))

        elif path == "/api/chat":
            file_path = qs.get("file", [None])[0]
            if not file_path:
                self.send_json({"error": "file required"}, 400)
                return
            safe = self._safe_path(file_path)
            if not safe:
                self.send_json({"error": "access denied"}, 403)
                return
            self.send_json(parse_chat(safe))

        elif path == "/api/agent_graph":
            file_path = qs.get("file", [None])[0]
            if not file_path:
                self.send_json({"error": "file required"}, 400)
                return
            safe = self._safe_path(file_path)
            if not safe:
                self.send_json({"error": "access denied"}, 403)
                return
            self.send_json(extract_agent_graph(safe))

        elif path == "/api/mtime":
            file_path = qs.get("file", [None])[0]
            if not file_path:
                self.send_json({"error": "file required"}, 400)
                return
            safe = self._safe_path(file_path)
            if not safe:
                self.send_json({"error": "access denied"}, 403)
                return
            try:
                mtime = os.path.getmtime(safe)
                self.send_json({"mtime": mtime})
            except FileNotFoundError:
                self.send_json({"error": "not found"}, 404)

        elif path == "/api/project_mtime":
            pid = qs.get("project", [None])[0]
            if not pid or ".." in pid or "/" in pid:
                self.send_json({"error": "invalid project"}, 400)
                return
            project_path = os.path.join(PROJECTS_DIR, pid)
            jsonl_files = glob.glob(os.path.join(project_path, "*.jsonl"))
            if not jsonl_files:
                self.send_json({"mtime": 0})
                return
            max_mtime = max(os.path.getmtime(f) for f in jsonl_files)
            self.send_json({"mtime": max_mtime, "file_count": len(jsonl_files)})

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/api/analyze":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                self.send_json({"error": "invalid JSON"}, 400)
                return
            sessions_input = payload.get("sessions")
            if not sessions_input:
                self.send_json({"error": "sessions required"}, 400)
                return
            self.send_json(analyze_structured(sessions_input, self._safe_path))
        else:
            self.send_response(404)
            self.end_headers()


def main():
    parser = argparse.ArgumentParser(description="Claude Code トークン使用量ビューア")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}"
    print(f"Claude Token Viewer: {url}")
    print("終了するには Ctrl+C を押してください")

    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました")


if __name__ == "__main__":
    main()
