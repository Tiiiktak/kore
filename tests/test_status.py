#!/usr/bin/env python3
"""Session state detection: kore-bridge.pane_state() -> "busy" | "waiting" | "idle".

Fixtures are real Claude Code pane tails (captured from live sessions / the dashboard
preview), inlined so the test needs no tmux.
"""

import importlib.util
import os

import pytest

HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "kore")
_spec = importlib.util.spec_from_file_location("t_bridge_status", os.path.join(HERE, "kore-bridge.py"))
br = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(br)

RULE = "─" * 120
BOX = f"{RULE} topic ─\n❯ \n{RULE}\n  Opus 4.8 [medium] · ━━━─────── 33% · proj/ · master*\n  ⏵⏵ auto mode on (shift+tab to cycle)\n"


def pane(body: str, footer: str = BOX) -> str:
    return "● Some earlier answer text.\n\n" + body + "\n\n" + footer


BUSY = [
    "✻ Working… (27s · ↓ 1.5k tokens)",
    "✢ Working… (1m 47s · ↓ 3.8k tokens)",
    "* Cogitating… (12s · esc to interrupt)",
    "✻ Waiting for API response · will retry in 3m 46s · check your network",
    "✽ Zesting… (2m 40s · ↓ 11.4k tokens)",
    "· Topsy-turvying… (3s)",
]

IDLE = [
    "✻ Churned for 2m 13s · done 7:13 PM · 1 shell still running",
    "✻ Churned for 3m 55s · done 12:41 AM",
    "Baked for 40s",
    "✻ Baked for 14s · done 3:20 AM",
]


@pytest.mark.parametrize("line", BUSY)
def test_busy_spinner_lines(line):
    p = pane("● Doing the thing.\n  ⎿  Read 1 file\n\n" + line)
    assert br.pane_state(p) == "busy"
    assert br.is_busy(p)


@pytest.mark.parametrize("line", IDLE)
def test_idle_past_tense_lines(line):
    p = pane("● Finished; here is the summary.\n\n" + line)
    assert br.pane_state(p) == "idle"
    assert not br.is_busy(p)


def test_live_capture_busy_with_subagent_footer():
    # Captured from kore-kore: spinner above the input box, a subagent list below it.
    p = """  ⎿  (No output)
  ⎿  Allowed by auto mode classifier
  Reading 1 file… (ctrl+o to expand)
  ⎿  src/kore/workbench/index.html
✽ Zesting… (2m 40s · ↓ 11.4k tokens)
""" + RULE + """ kore-multi-window-layout ─
❯
""" + RULE + """
  Opus 5.5 (1M context) [medium] · ━───────── 13% · kore/ · dev*
  ⏵⏵ auto mode on (shift+tab to cycle)
  ● main
  ◯ general-purpose  Reading is_busy call sites            1m 19s · ↓ 32.3k tokens
  ◯ general-purpose  Another agent                         2m 01s · ↓ 12.0k tokens
  ◯ general-purpose  Third agent                           0m 41s · ↓ 2.0k tokens
"""
    assert br.pane_state(p) == "busy"


def test_live_capture_idle_skill():
    # Captured from kore-skill.
    p = """  - 旧的 stdlib 8095 服务已停。
  全量仍在后台跑(concurrency 4),跑完我回来汇报。
✻ Churned for 2m 13s · done 7:13 PM · 1 shell still running
""" + RULE + """ design-extraction-eval-poc ─
❯
""" + RULE + """
  Opus 4.8 [medium] · ━━──────── 27% · skill-extract/ · master*        new task? /clear to save 266.5k tokens
  ⏵⏵ auto mode on · 1 shell
"""
    assert br.pane_state(p) == "idle"


def test_fresh_session_is_idle():
    p = """           Claude Code v2.1.309
 ▐▛███▛█   Opus 4.8 with medium effort
▝▜██████▀  API Usage Billing
❯ /clear
""" + BOX
    assert br.pane_state(p) == "idle"


def test_stale_marker_far_up_scrollback_is_ignored():
    old = "* Cogitating… (12s · esc to interrupt)\nThinking about it, esc to interrupt\n"
    filler = "\n".join(f"line {i} of the final answer" for i in range(40))
    p = pane(old + filler + "\n✻ Churned for 1m 2s · done 9:00 PM")
    assert br.pane_state(p) == "idle"
    # Even without a past-tense line, a marker beyond the tail window does not count.
    assert br.pane_state(pane(old + filler)) == "idle"


def test_past_tense_after_old_spinner_wins():
    p = pane("✻ Working… (27s · ↓ 1.5k tokens)\n● Done.\n✻ Baked for 40s")
    assert br.pane_state(p) == "idle"


def test_legacy_marker_in_tail_still_counts():
    assert br.pane_state(pane("Generating… esc to interrupt")) == "busy"


PERMISSION = """● Bash(rm -rf build/)
  ⎿  Running…

────────────────────────────────────────────────────────────
 Bash command

   rm -rf build/
   Remove the build directory

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in /proj
   3. No, and tell Claude what to do differently (esc)
"""

BOXED_PERMISSION = """╭──────────────────────────────────────────────╮
│ Edit file                                    │
│ Do you want to make this edit to app.py?     │
│ ❯ 1. Yes                                     │
│   2. Yes, allow all edits during this session│
│   3. No, and tell Claude what to do (esc)    │
╰──────────────────────────────────────────────╯
"""

ASK_USER = """● User answered nothing yet.

 ☐ Layout

Which layout would you like?

❯ 1. Grid
     Equal tiles
  2. Tabs
     One pane at a time
  3. Type something.

Enter to select · ↑/↓ to navigate · Esc to cancel
"""


@pytest.mark.parametrize("p", [PERMISSION, BOXED_PERMISSION, ASK_USER])
def test_waiting_prompts(p):
    assert br.pane_state("earlier output\n" + p) == "waiting"
    assert not br.is_busy("earlier output\n" + p)


def test_numbered_list_in_answer_is_not_waiting():
    # A numbered list in Claude's prose, with the empty input box below, is idle.
    p = pane("Would you like to:\n❯ 1. ship it\n  2. keep going\n✻ Churned for 5s · done 1:00 PM")
    assert br.pane_state(p) == "idle"


def test_empty_and_none():
    assert br.pane_state("") == "idle"
    assert br.pane_state(None) == "idle"


def test_ansi_is_stripped():
    p = pane("\x1b[38;5;174m✻\x1b[39m \x1b[1mWorking…\x1b[22m (27s · ↓ 1.5k tokens)")
    assert br.pane_state(p) == "busy"
