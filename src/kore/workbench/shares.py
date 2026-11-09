"""Session share links: narrow, expiring, revocable capabilities for ONE tmux session.

The board token drives every pane on every node, so it can never be handed out. A share is
the opposite: one session, one scope, a deadline.

  scope "read"  — watch the session's screen
  scope "chat"  — also send it a one-line message and get the agent's reply (koreops `send`,
                  i.e. the same write door, validation, rate limit and audit as the board's)

Only the token's sha256 is stored (in STATE_HOME — durable, rarely written, so it may live
on a shared home); the token itself is shown once, at creation. Records are kept in memory
after the first read: this module is the only writer, and lookups happen per request.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from typing import Any

SCOPES = ("read", "chat")
TTL_CHOICES = (3600, 86400, 7 * 86400)   # 1h / 24h / 7d — what the UI offers
MAX_TTL = 30 * 86400
CHAT_PER_MINUTE = 10                     # per share, on top of koreops' global write limit


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class ShareStore:
    def __init__(self, path: str) -> None:
        self.path = path
        self._mu = threading.Lock()
        self._recs: dict[str, dict[str, Any]] | None = None   # id -> record
        self._hits: dict[str, list[float]] = {}               # id -> chat send times

    # -- persistence ----------------------------------------------------------------
    def _load(self) -> dict[str, dict[str, Any]]:
        if self._recs is None:
            try:
                with open(self.path, encoding="utf-8") as f:
                    d = json.load(f)
                self._recs = {k: v for k, v in d.items() if isinstance(v, dict)} \
                    if isinstance(d, dict) else {}
            except (OSError, ValueError):
                self._recs = {}
        return self._recs

    def _save(self) -> None:
        recs = self._load()
        now = time.time()
        # Drop long-dead records so the file doesn't grow forever (a week past expiry/revoke).
        for sid in [k for k, r in recs.items()
                    if (r.get("revoked_at") or r.get("expires_at", 0)) < now - 7 * 86400]:
            del recs[sid]
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = f"{self.path}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(recs, f, ensure_ascii=False)
        os.chmod(tmp, 0o600)          # hashes only, but still nobody else's business
        os.replace(tmp, self.path)

    # -- owner side (board token) -----------------------------------------------------
    def create(self, node_ip: str, name: str, scope: str, ttl_s: int,
               label: str = "") -> dict[str, Any]:
        if scope not in SCOPES:
            raise ValueError(f"scope must be one of {SCOPES}")
        ttl_s = int(ttl_s)
        if not 60 <= ttl_s <= MAX_TTL:
            raise ValueError(f"ttl_s must be between 60 and {MAX_TTL}")
        label = str(label or "").strip()[:60]
        if any(ord(c) < 32 for c in label):
            raise ValueError("label: no control characters")
        token = secrets.token_urlsafe(24)
        now = time.time()
        rec = {"id": secrets.token_hex(4), "hash": _hash(token), "node_ip": node_ip,
               "name": name, "scope": scope, "label": label, "created_at": now,
               "expires_at": now + ttl_s, "revoked_at": None}
        with self._mu:
            self._load()[rec["id"]] = rec
            self._save()
        return {**self.public(rec), "token": token}

    def list(self, node_ip: str, name: str) -> list[dict[str, Any]]:
        now = time.time()
        with self._mu:
            recs = [r for r in self._load().values()
                    if r["node_ip"] == node_ip and r["name"] == name
                    and not r.get("revoked_at") and r["expires_at"] > now]
        return [self.public(r) for r in sorted(recs, key=lambda r: r["created_at"])]

    def revoke(self, share_id: str) -> bool:
        with self._mu:
            rec = self._load().get(share_id)
            if not rec or rec.get("revoked_at"):
                return False
            rec["revoked_at"] = time.time()
            self._save()
            return True

    # -- recipient side (share token) -------------------------------------------------
    def lookup(self, token: str) -> dict[str, Any] | None:
        """The live record for a token, or None (unknown, revoked or expired). The token is
        random, so finding its hash among the records is the whole check."""
        if not token or len(token) > 64:
            return None
        h = _hash(token)
        now = time.time()
        with self._mu:
            for r in self._load().values():
                if secrets.compare_digest(r["hash"], h):
                    if r.get("revoked_at") or r["expires_at"] <= now:
                        return None
                    return dict(r)
        return None

    def chat_allowed(self, share_id: str) -> bool:
        """Per-share chat budget, CHAT_PER_MINUTE over a sliding minute (in memory)."""
        now = time.time()
        with self._mu:
            hits = [t for t in self._hits.get(share_id, []) if now - t < 60]
            if len(hits) >= CHAT_PER_MINUTE:
                self._hits[share_id] = hits
                return False
            hits.append(now)
            self._hits[share_id] = hits
            return True

    @staticmethod
    def public(rec: dict[str, Any]) -> dict[str, Any]:
        return {k: rec[k] for k in ("id", "node_ip", "name", "scope", "label",
                                     "created_at", "expires_at")}


def reply_after(screen: str, message: str) -> str:
    """The agent's answer, cut from the screen: everything after the LAST line carrying the
    message we sent (Claude Code echoes the prompt). The whole screen if it isn't found."""
    lines = screen.splitlines()
    probe = message.strip()[:60]
    if probe:
        for i in range(len(lines) - 1, -1, -1):
            if probe in lines[i]:
                return "\n".join(lines[i + 1:]).strip("\n")
    return screen
